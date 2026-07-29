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

/**
 * Admin endpoint to approve or reject a withdrawal request.
 * 
 * POST /api/adminWithdrawal
 * Headers: Authorization: Bearer <ADMIN_SECRET>
 * Body: { withdrawalId, action: "approved" | "paid" | "rejected", note: "optional" }
 * 
 * How to use (via curl or Postman):
 *   curl -X POST https://nabprizebackend.vercel.app/api/adminWithdrawal \
 *     -H "Authorization: Bearer YOUR_ADMIN_SECRET" \
 *     -H "Content-Type: application/json" \
 *     -d '{"withdrawalId": "abc123", "action": "paid", "note": "Sent via Tremendous"}'
 */
module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
    }

    // Auth check using a separate ADMIN_SECRET env variable
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.ADMIN_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { withdrawalId, action, note } = req.body;

    if (!withdrawalId || !action) {
        return res.status(400).json({ error: 'withdrawalId and action are required.' });
    }

    if (!['approved', 'paid', 'rejected'].includes(action)) {
        return res.status(400).json({ error: 'action must be: approved, paid, or rejected' });
    }

    const withdrawalRef = db.collection('withdrawalRequests').doc(withdrawalId);

    try {
        await db.runTransaction(async (t) => {
            const withdrawalSnap = await t.get(withdrawalRef);

            if (!withdrawalSnap.exists) {
                throw new Error(`Withdrawal request ${withdrawalId} not found.`);
            }

            const data = withdrawalSnap.data();

            // Idempotency: don't reprocess already finalized requests
            if (['approved', 'paid', 'rejected'].includes(data.status)) {
                throw new Error(`Request already finalized with status: ${data.status}`);
            }

            const updateFields = {
                status: action,
                reviewedAt: admin.firestore.Timestamp.now(),
                adminNote: note || null
            };

            if (action === 'paid') {
                updateFields.paidAt = admin.firestore.Timestamp.now();
            }

            t.update(withdrawalRef, updateFields);

            // Only deduct balance on approved or paid
            if (action === 'approved' || action === 'paid') {
                const userRef = db.collection('users').doc(data.userId);
                const userSnap = await t.get(userRef);

                if (!userSnap.exists) {
                    throw new Error(`User ${data.userId} not found.`);
                }

                const userBalance = userSnap.data().directWalletBalance || 0;

                if (userBalance < data.amount) {
                    console.warn(`[adminWithdrawal] User ${data.userId} balance ($${userBalance}) is less than withdrawal amount ($${data.amount}). Proceeding anyway.`);
                }

                t.update(userRef, {
                    directWalletBalance: admin.firestore.FieldValue.increment(-data.amount)
                });

                // Create a withdrawal transaction record
                const txRef = db.collection('transactions').doc();
                t.set(txRef, {
                    userId: data.userId,
                    type: 'withdrawal',
                    amountGross: data.amount,
                    amountUserCredit: -data.amount,
                    status: 'confirmed',
                    payoutMethod: data.payoutMethod,
                    withdrawalRequestId: withdrawalId,
                    createdAt: admin.firestore.Timestamp.now(),
                    confirmedAt: admin.firestore.Timestamp.now()
                });

                console.log(`[adminWithdrawal] ✅ Deducted $${data.amount} from user ${data.userId}. Action: ${action}`);
            } else {
                console.log(`[adminWithdrawal] ❌ Withdrawal ${withdrawalId} rejected. No balance change.`);
            }
        });

        return res.status(200).json({
            message: `Withdrawal ${withdrawalId} updated to '${action}' successfully.`
        });

    } catch (error) {
        console.error(`[adminWithdrawal] Error:`, error.message);
        return res.status(500).json({ error: error.message });
    }
};
