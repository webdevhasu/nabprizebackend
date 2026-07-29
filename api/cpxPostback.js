const admin = require('firebase-admin');
const crypto = require('crypto');

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

function getWeekId(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1)/7);
    return `${d.getUTCFullYear()}-W${weekNo}`;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).send('Method Not Allowed');
    }

    const { status, trans_id, user_id, amount_usd, hash, secure_hash } = req.query;
    const receivedHash = hash || secure_hash; // support both just in case
    console.log(`Received CPX postback:`, req.query);

    const APP_SECURE_HASH = process.env.APP_SECURE_HASH;
    if (!APP_SECURE_HASH) {
        console.error("APP_SECURE_HASH is not set");
        return res.status(500).send("Server Error");
    }

    const expectedHash = crypto.createHash('md5').update(`${trans_id}-${APP_SECURE_HASH}`).digest('hex');
    if (receivedHash !== expectedHash) {
        console.error(`Hash mismatch. Expected: ${expectedHash}, Got: ${receivedHash}`);
        return res.status(403).send("Forbidden");
    }

    if (!status || !trans_id || !user_id || !amount_usd) {
        console.error("Missing parameters");
        return res.status(400).send("Bad Request");
    }

    const amountUsd = parseFloat(amount_usd);

    try {
        await db.runTransaction(async (t) => {
            // Check existing transaction
            const txQuery = await t.get(db.collection('transactions').where('cpxTransId', '==', trans_id));
            let existingTx = null;
            if (!txQuery.empty) {
                existingTx = txQuery.docs[0];
            }

            if (status === '1') {
                if (existingTx) {
                    console.log(`Transaction ${trans_id} already exists (Idempotency).`);
                    return; 
                }

                const userRef = db.collection('users').doc(user_id);
                const userSnap = await t.get(userRef);
                if (!userSnap.exists) {
                    throw new Error(`User ${user_id} not found`);
                }
                const userData = userSnap.data();
                
                const userCredit = amountUsd * 0.70;
                const luckyDrawCredit = amountUsd * 0.10;
                const referralCredit = amountUsd * 0.05;

                // 1. Update user
                t.update(userRef, {
                    pendingWalletBalance: admin.firestore.FieldValue.increment(userCredit)
                });

                // 2. Lucky Draw Pool
                const weekId = getWeekId(new Date());
                const luckyDrawRef = db.collection('luckyDrawPool').doc(weekId);
                t.set(luckyDrawRef, {
                    poolAmount: admin.firestore.FieldValue.increment(luckyDrawCredit),
                    status: "accumulating"
                }, { merge: true });

                // 3. Create Transaction
                const now = admin.firestore.Timestamp.now();
                const confirmedAt = new Date();
                confirmedAt.setDate(confirmedAt.getDate() + 3);
                const newTxRef = db.collection('transactions').doc();
                t.set(newTxRef, {
                    userId: user_id,
                    type: 'offerwall_task',
                    source: 'cpx_research',
                    amountGross: amountUsd,
                    amountUserCredit: userCredit,
                    status: 'pending',
                    cpxTransId: trans_id,
                    createdAt: now,
                    confirmedAt: admin.firestore.Timestamp.fromDate(confirmedAt)
                });

                // 4. Daily Progress
                const todayStr = new Date().toISOString().split('T')[0];
                const dailyRef = db.collection('dailyProgress').doc(`${user_id}_${todayStr}`);
                const dailySnap = await t.get(dailyRef);
                let currentEarned = 0;
                if (dailySnap.exists) {
                    currentEarned = dailySnap.data().amountEarnedToday || 0;
                }
                const newEarned = currentEarned + userCredit;
                t.set(dailyRef, {
                    userId: user_id,
                    date: todayStr,
                    amountEarnedToday: admin.firestore.FieldValue.increment(userCredit),
                    metDailyGoal: newEarned >= 1.50
                }, { merge: true });

                // 5. Referrals
                if (userData.referredBy) {
                    const referrerId = userData.referredBy;
                    // Find referral doc
                    const refQuery = await t.get(db.collection('referrals').where('refereeId', '==', user_id).where('referrerId', '==', referrerId));
                    if (!refQuery.empty) {
                        const referralDoc = refQuery.docs[0];
                        const referralRef = referralDoc.ref;
                        const refData = referralDoc.data();
                        
                        // We need to know if total completed tasks >= $1. For simplicity in this transaction, 
                        // if they earned > $0, we might just assume it's active, or check total sum.
                        // Let's activate it if amountUsd >= 1 or if it's already active.
                        // (A more rigorous approach queries all past transactions, but we'll do a simple threshold check)
                        let newStatus = refData.status;
                        if (newStatus === 'pending_activation' && amountUsd >= 1.0) {
                            newStatus = 'active';
                        } else if (newStatus === 'pending_activation') {
                            // Fetch sum of all user's transactions to see if >= $1
                            const allTx = await t.get(db.collection('transactions').where('userId', '==', user_id));
                            let totalUsd = amountUsd;
                            allTx.forEach(doc => { totalUsd += (doc.data().amountGross || 0) });
                            if (totalUsd >= 1.0) newStatus = 'active';
                        }

                        if (newStatus === 'active') {
                            t.update(referralRef, {
                                status: 'active',
                                totalCommissionEarned: admin.firestore.FieldValue.increment(referralCredit)
                            });
                            
                            // Credit referrer
                            const referrerUserRef = db.collection('users').doc(referrerId);
                            t.update(referrerUserRef, {
                                pendingWalletBalance: admin.firestore.FieldValue.increment(referralCredit)
                            });

                            // Create referral commission transaction
                            const commTxRef = db.collection('transactions').doc();
                            t.set(commTxRef, {
                                userId: referrerId,
                                type: 'referral_commission',
                                source: 'cpx_research',
                                amountGross: null,
                                amountUserCredit: referralCredit,
                                status: 'pending',
                                cpxTransId: trans_id + "_ref", 
                                createdAt: now,
                                confirmedAt: admin.firestore.Timestamp.fromDate(confirmedAt)
                            });
                        }
                    }
                }

            } else if (status === '2') { // Reversal
                if (!existingTx) {
                    console.log(`Reversal ignored: Transaction ${trans_id} not found.`);
                    return;
                }
                
                const txData = existingTx.data();
                if (txData.status === 'reversed') return; // Already reversed

                const txRef = existingTx.ref;
                t.update(txRef, { status: 'reversed' });

                const userRef = db.collection('users').doc(txData.userId);
                
                if (txData.status === 'confirmed') {
                    // Deduct from directWalletBalance
                    t.update(userRef, {
                        directWalletBalance: admin.firestore.FieldValue.increment(-txData.amountUserCredit)
                    });
                } else if (txData.status === 'pending') {
                    // Just deduct from pendingWalletBalance (or let the 3-day cron ignore it, but since we incremented it, we must deduct it now)
                    t.update(userRef, {
                        pendingWalletBalance: admin.firestore.FieldValue.increment(-txData.amountUserCredit)
                    });
                }

                // Reverse referral commission if any
                const commTxQuery = await t.get(db.collection('transactions').where('cpxTransId', '==', trans_id + "_ref"));
                if (!commTxQuery.empty) {
                    const commTxDoc = commTxQuery.docs[0];
                    const commTxData = commTxDoc.data();
                    t.update(commTxDoc.ref, { status: 'reversed' });
                    
                    const referrerRef = db.collection('users').doc(commTxData.userId);
                    if (commTxData.status === 'confirmed') {
                        t.update(referrerRef, { directWalletBalance: admin.firestore.FieldValue.increment(-commTxData.amountUserCredit) });
                    } else if (commTxData.status === 'pending') {
                        t.update(referrerRef, { pendingWalletBalance: admin.firestore.FieldValue.increment(-commTxData.amountUserCredit) });
                    }
                    
                    // Deduct from referral total
                    const refQuery = await t.get(db.collection('referrals').where('refereeId', '==', txData.userId).where('referrerId', '==', commTxData.userId));
                    if (!refQuery.empty) {
                        t.update(refQuery.docs[0].ref, {
                            totalCommissionEarned: admin.firestore.FieldValue.increment(-commTxData.amountUserCredit)
                        });
                    }
                }
            }
        });
        
        return res.status(200).send("OK");
    } catch (error) {
        console.error("Error processing postback:", error);
        return res.status(500).send("Server Error");
    }
};
