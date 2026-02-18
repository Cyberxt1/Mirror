import { v2 as cloudinary } from 'cloudinary'
import { onRequest } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { setGlobalOptions } from 'firebase-functions/v2'
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getAppCheck } from 'firebase-admin/app-check'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'

setGlobalOptions({ region: 'us-central1' })

initializeApp()

const cloudName = process.env.CLOUDINARY_CLOUD_NAME
const apiKey = process.env.CLOUDINARY_API_KEY
const apiSecret = process.env.CLOUDINARY_API_SECRET
const allowMissingAppCheck = String(process.env.ALLOW_MISSING_APPCHECK || '').toLowerCase() === 'true'
const maxImageBytes = 10 * 1024 * 1024
const maxVideoBytes = 60 * 1024 * 1024
const feedWindowHours = 24
const cleanupBatchSize = 400

cloudinary.config({
  cloud_name: cloudName,
  api_key: apiKey,
  api_secret: apiSecret,
})

const handleSignature = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed')
    return
  }

  if (!cloudName || !apiKey || !apiSecret) {
    res.status(500).send('Missing Cloudinary server configuration.')
    return
  }

  const authHeader = req.headers.authorization || ''
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  const appCheckToken = req.header('X-Firebase-AppCheck')

  try {
    if (!idToken) {
      res.status(401).send('Missing auth token')
      return
    }
    const decoded = await getAuth().verifyIdToken(idToken)

    if (!allowMissingAppCheck) {
      if (!appCheckToken) {
        res.status(401).send('Missing App Check token')
        return
      }
      await getAppCheck().verifyToken(appCheckToken)
    }

    const { folder = 'mirror', resource_type = 'image', fileName = '', fileSize = 0 } = req.body || {}
    const resourceType = resource_type === 'video' ? 'video' : 'image'
    const maxBytes = resourceType === 'video' ? maxVideoBytes : maxImageBytes

    if (fileSize && fileSize > maxBytes) {
      res.status(400).send('File is too large.')
      return
    }

    const safeFolder = folder.replace(/[^a-zA-Z0-9/_-]/g, '')
    const timestamp = Math.round(Date.now() / 1000)
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '')
    const publicId = `${decoded.uid}/${timestamp}-${safeName}`.slice(0, 180)

    const signature = cloudinary.utils.api_sign_request(
      {
        timestamp,
        folder: safeFolder || 'mirror',
        public_id: publicId,
        resource_type: resourceType,
      },
      apiSecret,
    )

    res.status(200).json({
      signature,
      timestamp,
      apiKey,
      folder: safeFolder || 'mirror',
      publicId,
      cloudName,
    })
  } catch (error) {
    res.status(401).send(error.message || 'Unauthorized')
  }
})

export const signCloudinary = handleSignature
export const getUploadSignature = handleSignature

// Delete anonymous feed posts older than 24h so they disappear globally.
export const cleanupExpiredPosts = onSchedule('every 15 minutes', async () => {
  const db = getFirestore()
  const cutoffMs = Date.now() - feedWindowHours * 60 * 60 * 1000
  const cutoff = Timestamp.fromMillis(cutoffMs)
  let deletedCount = 0

  while (true) {
    const snap = await db
      .collection('picture_posts')
      .where('created_at', '<=', cutoff)
      .limit(cleanupBatchSize)
      .get()

    if (snap.empty) break

    const batch = db.batch()
    snap.docs.forEach((docSnap) => batch.delete(docSnap.ref))
    await batch.commit()
    deletedCount += snap.size

    if (snap.size < cleanupBatchSize) break
  }

  console.log(`cleanupExpiredPosts deleted ${deletedCount} post(s) older than ${feedWindowHours}h`)
})
