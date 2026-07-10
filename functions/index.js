const functions = require("firebase-functions");
const { admin, db, FieldValue } = require("./firebaseAdmin");

/**
 * Securely send or broadcast a notification.
 * Requires the caller to have the { admin: true } custom claim.
 *
 * Region: asia-south1 (Mumbai). Must match the frontend getFunctions() region.
 */
exports.sendNotification = functions.https.onCall({ region: "asia-south1" }, async (request) => {
  const data = request.data;
  const context = request;
  functions.logger.info("sendNotification invoked. Incoming data:", JSON.stringify(data));

  // ── Admin Claim Verification (with detailed logging) ──
  if (!context.auth) {
    functions.logger.error("sendNotification: REJECTED — No auth context. Caller is not authenticated.");
    throw new functions.https.HttpsError(
      "unauthenticated",
      "You must be logged in to send notifications."
    );
  }

  if (!context.auth.token.admin) {
    functions.logger.warn(
      `sendNotification: REJECTED — User ${context.auth.uid} does NOT have admin claim.`,
      `Current claims: ${JSON.stringify(context.auth.token)}`
    );
    throw new functions.https.HttpsError(
      "permission-denied",
      "Admin privileges required. Run: node scripts/setAdmin.js <YOUR_UID>"
    );
  }

  functions.logger.info(`sendNotification: AUTHORIZED — Admin ${context.auth.uid} proceeding.`);

  try {
    if (!data || typeof data !== "object") {
      throw new functions.https.HttpsError("invalid-argument", "Payload must be a valid object.");
    }

    const title = typeof data.title === "string" ? data.title.trim() : "";
    const message = typeof data.message === "string" ? data.message.trim() : "";
    const rawType = typeof data.type === "string" ? data.type.trim() : "info";
    const targetUidProvided = data.targetUid !== undefined && data.targetUid !== null;
    const targetUid = targetUidProvided ? String(data.targetUid).trim() : "";

    if (!title) {
      throw new functions.https.HttpsError("invalid-argument", "title is required.");
    }
    if (!message) {
      throw new functions.https.HttpsError("invalid-argument", "message is required.");
    }

    const validTypes = new Set(["info", "success", "warning"]);
    if (!validTypes.has(rawType)) {
      throw new functions.https.HttpsError("invalid-argument", "type must be one of: info, success, warning.");
    }

    if (targetUidProvided && !targetUid) {
      throw new functions.https.HttpsError("invalid-argument", "targetUid must be a non-empty string when provided.");
    }

    const notificationsRef = db.collection("notifications");
    const notificationData = {
      title,
      message,
      type: rawType,
      isRead: false,
      createdAt: FieldValue.serverTimestamp(),
    };

    if (targetUid) {
      await notificationsRef.add({
        ...notificationData,
        userId: targetUid,
      });

      functions.logger.info(`Admin ${context.auth.uid} sent a notification to user ${targetUid}.`);
      return { success: true, detail: "Notification sent." };
    }

    const usersSnapshot = await db.collection("users").get();
    if (usersSnapshot.empty) {
      throw new functions.https.HttpsError("not-found", "No users found for broadcast.");
    }

    const uniqueUids = new Set();
    usersSnapshot.forEach((userDoc) => {
      const dataUid = userDoc.get("uid");
      const fallbackUid = userDoc.id;
      const candidate = (typeof dataUid === "string" ? dataUid : fallbackUid || "").trim();
      if (candidate) uniqueUids.add(candidate);
    });

    if (uniqueUids.size === 0) {
      throw new functions.https.HttpsError("not-found", "No valid user UIDs found for broadcast.");
    }

    const uids = Array.from(uniqueUids);
    const BATCH_SIZE = 500;
    for (let i = 0; i < uids.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const chunk = uids.slice(i, i + BATCH_SIZE);
      chunk.forEach((uid) => {
        const docRef = notificationsRef.doc();
        batch.set(docRef, {
          ...notificationData,
          userId: uid,
        });
      });
      await batch.commit();
    }

    functions.logger.info(`Admin ${context.auth.uid} broadcasted a notification to ${uids.length} users.`);
    return { success: true, detail: `Broadcasted to ${uids.length} users.` };
  } catch (error) {
    functions.logger.error("sendNotification: FAILED —", error.message || error, { stack: error.stack });
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError("internal", error.message || "Internal server error.");
  }
});
