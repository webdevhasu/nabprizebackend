const admin = require('firebase-admin');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
        })
    });
}
const db = admin.firestore();

module.exports = async function handler(req, res) {
    // Security: Only allow Vercel Cron calls (or manual calls with secret)
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log(`[releasePendingEarnings] Cron job started at ${new Date().toISOString()}`);

    const now = admin.firestore.Timestamp.now();
    let processed = 0;
    let skippedReversed = 0;
    let errors = 0;

    try {
        // 1. Query all pending transactions where confirmedAt <= now
        const pendingQuery = await db.collection('transactions')
            .where('status', '==', 'pending')
            .where('confirmedAt', '<=', now)
            .get();

        if (pendingQuery.empty) {
            console.log(`[releasePendingEarnings] No pending transactions to process.`);
            return res.status(200).json({ message: 'No transactions to process', processed: 0 });
        }

        console.log(`[releasePendingEarnings] Found ${pendingQuery.size} transactions to evaluate.`);

        // 2. Process each transaction individually in its own Firestore transaction
        for (const txDoc of pendingQuery.docs) {
            const txData = txDoc.data();
            const txId = txDoc.id;

            try {
                await db.runTransaction(async (t) => {
                    // Re-read the transaction inside the atomic transaction to avoid race conditions
                    const freshTx = await t.get(txDoc.ref);
                    const freshData = freshTx.data();

                    // 3. Skip reversed transactions
                    if (freshData.status === 'reversed') {
                        console.log(`[releasePendingEarnings] TX ${txId} is reversed — skipping.`);
                        skippedReversed++;
                        return;
                    }

                    // Safety check: skip if already confirmed
                    if (freshData.status === 'confirmed') {
                        console.log(`[releasePendingEarnings] TX ${txId} already confirmed — skipping.`);
                        return;
                    }

                    const userRef = db.collection('users').doc(freshData.userId);

                    // Move amountUserCredit: pending → direct
                    t.update(userRef, {
                        pendingWalletBalance: admin.firestore.FieldValue.increment(-freshData.amountUserCredit),
                        directWalletBalance: admin.firestore.FieldValue.increment(freshData.amountUserCredit)
                    });

                    // Mark transaction as confirmed
                    t.update(txDoc.ref, {
                        status: 'confirmed',
                        releasedAt: now
                    });

                    processed++;
                    console.log(`[releasePendingEarnings] TX ${txId} confirmed. User ${freshData.userId} credited $${freshData.amountUserCredit.toFixed(4)}`);
                });
            } catch (txError) {
                errors++;
                console.error(`[releasePendingEarnings] Failed to process TX ${txId}:`, txError);
            }
        }

        const summary = {
            message: 'Cron job completed',
            processed,
            skippedReversed,
            errors,
            timestamp: new Date().toISOString()
        };

        console.log(`[releasePendingEarnings] Summary:`, summary);
        return res.status(200).json(summary);

    } catch (error) {
        console.error(`[releasePendingEarnings] Fatal error:`, error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};
