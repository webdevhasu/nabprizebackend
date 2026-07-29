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
const messaging = admin.messaging();

// --- Helpers ---

function getWeekId(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function getPast7DayStrings() {
    const days = [];
    for (let i = 1; i <= 7; i++) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - i);
        days.push(d.toISOString().split('T')[0]);
    }
    return days;
}

function getNextWeekId(currentWeekId) {
    const [year, week] = currentWeekId.split('-W').map(Number);
    const date = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
    date.setUTCDate(date.getUTCDate() + 7);
    return getWeekId(date);
}

// --- Main Handler ---

module.exports = async function handler(req, res) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const now = new Date();
    // Draw for the week that just ended (last week's pool)
    const lastWeekDate = new Date(now);
    lastWeekDate.setUTCDate(lastWeekDate.getUTCDate() - 1);
    const weekId = getWeekId(lastWeekDate);
    const nextWeekId = getNextWeekId(weekId);

    console.log(`[runWeeklyLuckyDraw] Starting draw for week: ${weekId}`);

    try {
        // 1. Read pool document
        const poolRef = db.collection('luckyDrawPool').doc(weekId);
        const poolSnap = await poolRef.get();

        if (!poolSnap.exists) {
            console.warn(`[runWeeklyLuckyDraw] No pool found for ${weekId}. Aborting.`);
            return res.status(200).json({ message: `No pool for ${weekId}` });
        }

        const poolData = poolSnap.data();
        if (poolData.status === 'drawn') {
            console.warn(`[runWeeklyLuckyDraw] Draw already done for ${weekId}. Skipping.`);
            return res.status(200).json({ message: 'Already drawn' });
        }

        const poolAmount = poolData.poolAmount || 0;
        const previousWinner1 = poolData.previousFirstPlaceWinnerId || null;
        const previousWinner2 = poolData.previousSecondFirstPlaceWinnerId || null;

        // 2. Determine qualifying users
        const past7Days = getPast7DayStrings();

        // Get all users
        const usersSnap = await db.collection('users').get();
        const qualifiedUsers = [];

        for (const userDoc of usersSnap.docs) {
            const uid = userDoc.id;
            const userData = userDoc.data();

            let surveyQualifyingDays = 0;
            let adTicketDays = 0;

            // Check daily progress for past 7 days
            for (const dayStr of past7Days) {
                const dpId = `${uid}_${dayStr}`;
                const dpSnap = await db.collection('dailyProgress').doc(dpId).get();
                if (dpSnap.exists) {
                    const dp = dpSnap.data();
                    if (dp.metDailyGoal === true) surveyQualifyingDays++;
                    if ((dp.adsWatchedToday || 0) >= 5) adTicketDays++;
                }
            }

            const totalBalance = (userData.pendingWalletBalance || 0) + (userData.directWalletBalance || 0);

            // Qualification criteria
            const surveyQualified = surveyQualifyingDays >= 5 && totalBalance >= 10.0;
            const adQualified = adTicketDays >= 5;

            if (surveyQualified || adQualified) {
                qualifiedUsers.push({
                    uid,
                    surveyDays: surveyQualifyingDays,
                    adDays: adTicketDays,
                    qualifyingDays: Math.max(surveyQualifyingDays, adTicketDays)
                });
            }
        }

        console.log(`[runWeeklyLuckyDraw] ${qualifiedUsers.length} users qualified.`);

        if (qualifiedUsers.length === 0) {
            await poolRef.update({ status: 'drawn', winners: [], drawnAt: admin.firestore.Timestamp.now() });
            console.warn(`[runWeeklyLuckyDraw] No qualified users. Pool saved with empty winners.`);
            return res.status(200).json({ message: 'No qualified users' });
        }

        // 3. Weighted random selection (weighted by qualifying days)
        const pickWeighted = (pool) => {
            const totalWeight = pool.reduce((sum, u) => sum + u.qualifyingDays, 0);
            let r = Math.random() * totalWeight;
            for (const u of pool) {
                r -= u.qualifyingDays;
                if (r <= 0) return u;
            }
            return pool[pool.length - 1];
        };

        const selectedWinners = [];
        const remainingPool = [...qualifiedUsers];

        for (let i = 0; i < Math.min(10, remainingPool.length); i++) {
            // For 1st place, exclude previous 2 winners
            let eligiblePool = remainingPool;
            if (i === 0 && (previousWinner1 || previousWinner2)) {
                eligiblePool = remainingPool.filter(u =>
                    u.uid !== previousWinner1 && u.uid !== previousWinner2
                );
                if (eligiblePool.length === 0) eligiblePool = remainingPool; // fallback
            }

            const winner = pickWeighted(eligiblePool);
            selectedWinners.push(winner);
            const idx = remainingPool.findIndex(u => u.uid === winner.uid);
            if (idx > -1) remainingPool.splice(idx, 1);
        }

        // 4. Assign prizes
        const prizes = [];
        const perPlace = [
            poolAmount * 0.50,  // 1st
            poolAmount * 0.20,  // 2nd
            poolAmount * 0.10,  // 3rd
        ];
        const remaining20 = poolAmount * 0.20;
        for (let i = 3; i < Math.min(10, selectedWinners.length); i++) {
            perPlace.push(remaining20 / Math.min(7, selectedWinners.length - 3));
        }

        const drawTimestamp = admin.firestore.Timestamp.now();
        const winnerRecords = [];
        const batch = db.batch();

        for (let i = 0; i < selectedWinners.length; i++) {
            const winner = selectedWinners[i];
            const prizeAmount = perPlace[i] || 0;
            const place = i + 1;

            // 5. Create transaction for winner
            const txRef = db.collection('transactions').doc();
            batch.set(txRef, {
                userId: winner.uid,
                type: 'lucky_draw_win',
                amountGross: prizeAmount,
                amountUserCredit: prizeAmount,
                status: 'confirmed', // No 3-day hold on prize money
                weekId: weekId,
                place: place,
                createdAt: drawTimestamp,
                confirmedAt: drawTimestamp
            });

            // 6. Credit directWalletBalance directly
            const userRef = db.collection('users').doc(winner.uid);
            batch.update(userRef, {
                directWalletBalance: admin.firestore.FieldValue.increment(prizeAmount)
            });

            winnerRecords.push({
                userId: winner.uid,
                place,
                prize: prizeAmount
            });

            console.log(`[runWeeklyLuckyDraw] Place #${place}: User ${winner.uid} → $${prizeAmount.toFixed(4)}`);
        }

        // 7. Update current pool doc
        batch.update(poolRef, {
            status: 'drawn',
            winners: winnerRecords,
            drawnAt: drawTimestamp,
            previousFirstPlaceWinnerId: selectedWinners[0]?.uid || null,
            previousSecondFirstPlaceWinnerId: previousWinner1 || null
        });

        // 8. Create next week's pool
        const nextWeekRef = db.collection('luckyDrawPool').doc(nextWeekId);
        batch.set(nextWeekRef, {
            weekId: nextWeekId,
            poolAmount: 0,
            status: 'accumulating',
            previousFirstPlaceWinnerId: selectedWinners[0]?.uid || null,
            previousSecondFirstPlaceWinnerId: previousWinner1 || null,
            createdAt: drawTimestamp
        }, { merge: true });

        await batch.commit();
        console.log(`[runWeeklyLuckyDraw] Batch committed successfully.`);

        // 9. Send FCM notification to all users (topic broadcast)
        try {
            const topWinner = winnerRecords[0];
            await messaging.send({
                topic: 'all_users',
                notification: {
                    title: '🎉 Weekly Lucky Draw Results!',
                    body: `This week's Lucky Draw is done! The pool was $${poolAmount.toFixed(2)}. Check if you won!`
                },
                data: {
                    type: 'lucky_draw_results',
                    weekId: weekId,
                    poolAmount: poolAmount.toFixed(2)
                }
            });
            console.log(`[runWeeklyLuckyDraw] FCM notification sent.`);
        } catch (fcmError) {
            console.error(`[runWeeklyLuckyDraw] FCM notification failed (non-fatal):`, fcmError);
        }

        return res.status(200).json({
            message: 'Draw completed',
            weekId,
            poolAmount,
            winnersCount: winnerRecords.length,
            winners: winnerRecords
        });

    } catch (error) {
        console.error(`[runWeeklyLuckyDraw] Fatal error:`, error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};
