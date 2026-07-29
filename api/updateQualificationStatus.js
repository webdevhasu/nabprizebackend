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

function getPast7DayStrings() {
    const days = [];
    for (let i = 1; i <= 7; i++) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - i);
        days.push(d.toISOString().split('T')[0]);
    }
    return days;
}

/**
 * This function runs daily and updates each user's luckyDrawQualified field.
 * The Android app reads this field to show real-time qualification status.
 * Also accessible as a callable endpoint: GET /api/updateQualificationStatus
 */
module.exports = async function handler(req, res) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log(`[updateQualificationStatus] Starting at ${new Date().toISOString()}`);

    const past7Days = getPast7DayStrings();
    let updated = 0;
    let errors = 0;

    try {
        const usersSnap = await db.collection('users').get();

        const batchSize = 400; // Firestore batch limit is 500
        let batch = db.batch();
        let batchCount = 0;

        for (const userDoc of usersSnap.docs) {
            const uid = userDoc.id;
            const userData = userDoc.data();

            let surveyQualifyingDays = 0;
            let adTicketDays = 0;

            try {
                for (const dayStr of past7Days) {
                    const dpSnap = await db.collection('dailyProgress').doc(`${uid}_${dayStr}`).get();
                    if (dpSnap.exists) {
                        const dp = dpSnap.data();
                        if (dp.metDailyGoal === true) surveyQualifyingDays++;
                        if ((dp.adsWatchedToday || 0) >= 5) adTicketDays++;
                    }
                }

                const totalBalance = (userData.pendingWalletBalance || 0) + (userData.directWalletBalance || 0);
                const surveyQualified = surveyQualifyingDays >= 5 && totalBalance >= 10.0;
                const adQualified = adTicketDays >= 5;
                const isQualified = surveyQualified || adQualified;

                batch.update(userDoc.ref, {
                    luckyDrawQualified: isQualified,
                    luckyDrawSurveyDays: surveyQualifyingDays,
                    luckyDrawAdDays: adTicketDays,
                    luckyDrawQualifiedUpdatedAt: admin.firestore.Timestamp.now()
                });
                batchCount++;
                updated++;

                // Commit in chunks
                if (batchCount >= batchSize) {
                    await batch.commit();
                    batch = db.batch();
                    batchCount = 0;
                }

            } catch (userError) {
                errors++;
                console.error(`[updateQualificationStatus] Error for user ${uid}:`, userError);
            }
        }

        // Commit remaining
        if (batchCount > 0) {
            await batch.commit();
        }

        const summary = { message: 'Qualification status updated', updated, errors };
        console.log(`[updateQualificationStatus] Done:`, summary);
        return res.status(200).json(summary);

    } catch (error) {
        console.error(`[updateQualificationStatus] Fatal error:`, error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};
