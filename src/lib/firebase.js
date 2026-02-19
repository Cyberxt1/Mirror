import { initializeApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider } from 'firebase/auth'
import { enableIndexedDbPersistence, getFirestore } from 'firebase/firestore'
import { getToken as getAppCheckTokenInternal, initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

const isFirebaseConfigured =
  Boolean(firebaseConfig.apiKey) &&
  Boolean(firebaseConfig.authDomain) &&
  Boolean(firebaseConfig.projectId) &&
  Boolean(firebaseConfig.appId)
const shouldBypassAppCheck = import.meta.env.DEV && String(import.meta.env.VITE_DEV_BYPASS_APPCHECK || '').toLowerCase() === 'true'

let app
let auth
let db
let googleProvider
let appCheck

if (isFirebaseConfigured) {
  app = initializeApp(firebaseConfig)
  auth = getAuth(app)
  db = getFirestore(app)
  googleProvider = new GoogleAuthProvider()
  enableIndexedDbPersistence(db).catch((error) => {
    if (error?.code === 'failed-precondition') {
      console.warn('Firestore persistence disabled: multiple tabs open.')
    } else if (error?.code === 'unimplemented') {
      console.warn('Firestore persistence not supported in this browser.')
    } else {
      console.warn('Firestore persistence error:', error)
    }
  })

  const appCheckKey = import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY
  if (appCheckKey && !shouldBypassAppCheck) {
    try {
      appCheck = initializeAppCheck(app, {
        provider: new ReCaptchaV3Provider(appCheckKey),
        isTokenAutoRefreshEnabled: true,
      })
    } catch (error) {
      console.warn('App Check initialization failed:', error)
      appCheck = null
    }
  }
}

async function getAppCheckToken() {
  if (shouldBypassAppCheck) return null
  if (!appCheck) return null
  try {
    const { token } = await getAppCheckTokenInternal(appCheck)
    return token
  } catch (error) {
    console.warn('App Check token fetch failed:', error)
    return null
  }
}

export { app, auth, db, googleProvider, isFirebaseConfigured, appCheck, getAppCheckToken, shouldBypassAppCheck }
