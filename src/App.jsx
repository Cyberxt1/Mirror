
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  createUserWithEmailAndPassword,
  getIdToken,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut as firebaseSignOut,
} from 'firebase/auth'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  documentId,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore'
import { auth, db, getAppCheckToken, googleProvider, isFirebaseConfigured, shouldBypassAppCheck } from './lib/firebase'
import { uploadToCloudinarySigned } from './lib/cloudinary'

const emptyPost = {
  caption: '',
}

const hypeLines = ['Steeze', 'Join the Vibe', "Don't get left out in campus", 'Own the spotlight', 'Be the main feed']

const defaultCampus = import.meta.env.VITE_DEFAULT_CAMPUS || 'main'
const maxImageBytes = 10 * 1024 * 1024
const feedWindowMs = 24 * 60 * 60 * 1000
const feedPageSize = 12

const reactionTypes = [
  { key: 'annoyed', emoji: '😒' },
  { key: 'love', emoji: '❤️' },
  { key: 'surprised', emoji: '🫢' },
  { key: 'thumbs_up', emoji: '👍' },
  { key: 'laugh', emoji: '😂' },
]

const reactionKeys = reactionTypes.map((item) => item.key)
const roomAliasFirst = ['Brain', 'Pixel', 'Ghost', 'Velvet', 'Cosmic', 'Sunny', 'Midnight', 'Nova', 'Chill', 'Bold', 'Lucky', 'Quiet']
const roomAliasSecond = ['Deer', 'Panda', 'Viper', 'Otter', 'Raven', 'Koala', 'Lynx', 'Finch', 'Tiger', 'Cobra', 'Shark', 'Fox']
const roomTtlOptions = [
  { label: '30 minutes', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '3 hours', value: 180 },
  { label: '6 hours', value: 360 },
  { label: '12 hours', value: 720 },
  { label: '24 hours', value: 1440 },
  { label: '3 days', value: 4320 },
  { label: '7 days', value: 10080 },
]
const departmentsByFaculty = [
  { faculty: 'Law', items: ['Law'] },
  { faculty: 'Science', items: ['Computer Science', 'Mathematics', 'Physics', 'Chemistry', 'Biology', 'Microbiology', 'Statistics', 'Geology'] },
  { faculty: 'Engineering', items: ['Civil Engineering', 'Mechanical Engineering', 'Electrical Engineering', 'Chemical Engineering', 'Petroleum Engineering'] },
  { faculty: 'Medicine', items: ['Medicine and Surgery', 'Nursing', 'Pharmacy', 'Medical Laboratory Science', 'Physiotherapy'] },
  { faculty: 'Social Sciences', items: ['Economics', 'Political Science', 'Psychology', 'Sociology', 'Mass Communication', 'Geography'] },
  { faculty: 'Arts', items: ['English', 'History', 'Philosophy', 'Theatre Arts', 'Linguistics', 'Religious Studies'] },
]
const departmentNicknames = {
  'Computer Science': 'Techie',
  Mathematics: 'Number Ninja',
  Physics: 'Quantum Mind',
  Chemistry: 'Lab Wizard',
  Biology: 'Bio Brain',
  Microbiology: 'Culture Boss',
  Statistics: 'Data Sage',
  Geology: 'Rock Ranger',
  'Civil Engineering': 'Builder',
  'Mechanical Engineering': 'Machine Mind',
  'Electrical Engineering': 'Circuit Boss',
  'Chemical Engineering': 'Process Pro',
  'Petroleum Engineering': 'Oil Scout',
  'Medicine and Surgery': 'Medic',
  Nursing: 'Care Captain',
  Pharmacy: 'Rx Pro',
  'Medical Laboratory Science': 'Lab Medic',
  Physiotherapy: 'Rehab Coach',
  Economics: 'Market Mind',
  'Political Science': 'Policy Pro',
  Psychology: 'Mind Reader',
  Sociology: 'Society Lens',
  'Mass Communication': 'Media Voice',
  Geography: 'Map Master',
  Law: 'Counsel',
  English: 'Wordsmith',
  History: 'Chronicle Keeper',
  Philosophy: 'Thinker',
  'Theatre Arts': 'Performer',
  Linguistics: 'Language Pro',
  'Religious Studies': 'Faith Scholar',
}

function getDepartmentNickname(department) {
  return departmentNicknames[department] || 'Campus Voice'
}

function hashText(value) {
  let hash = 0
  for (let index = 0; index < String(value).length; index += 1) {
    hash = (hash * 31 + String(value).charCodeAt(index)) >>> 0
  }
  return hash
}

function generatePrivateAlias(userId) {
  const first = ['Jelly', 'Velvet', 'Cocoa', 'Mellow', 'Sunny', 'Silver', 'Mint', 'Neon', 'Echo', 'Lucky']
  const second = ['Bean', 'Comet', 'Whisper', 'Sparrow', 'Pixel', 'River', 'Mocha', 'Nova', 'Cloud', 'Rune']
  const hash = hashText(userId || 'mirror')
  const a = first[hash % first.length]
  const b = second[Math.floor(hash / first.length) % second.length]
  const suffix = String(userId || '0000').slice(-4).toLowerCase()
  return `${a} ${b} ${suffix}`.trim()
}

function generateRoomAlias(roomId, userId) {
  const seed = `${roomId || 'room'}:${userId || 'anon'}`
  const hash = hashText(seed)
  const first = roomAliasFirst[hash % roomAliasFirst.length]
  const second = roomAliasSecond[Math.floor(hash / roomAliasFirst.length) % roomAliasSecond.length]
  return `${first} ${second}`
}

function createEmptyReactionCounts() {
  return reactionKeys.reduce((counts, key) => ({ ...counts, [key]: 0 }), {})
}

function normalizeReactionCounts(value) {
  const fallback = createEmptyReactionCounts()
  if (!value || typeof value !== 'object') return fallback
  return reactionKeys.reduce((counts, key) => ({ ...counts, [key]: Number(value[key]) || 0 }), fallback)
}

function normalizeReactedBy(value) {
  if (!value || typeof value !== 'object') return {}
  return Object.entries(value).reduce((next, [userId, reactionKey]) => {
    if (!userId || !reactionKeys.includes(reactionKey)) return next
    return { ...next, [userId]: reactionKey }
  }, {})
}

function computeReactionTotal(reactionsCount) {
  const counts = normalizeReactionCounts(reactionsCount)
  return reactionKeys.reduce((sum, key) => sum + (counts[key] || 0), 0)
}

function computeSteezeScore({ engagementCount }) {
  const engagements = Math.max(0, engagementCount || 0)
  return Math.min(99, Number((engagements * 0.1).toFixed(1)))
}

function normalizeProfile(data, fallback) {
  return {
    displayName: data?.displayName ?? data?.display_name ?? fallback.displayName,
    username: data?.username ?? fallback.username,
    campusId: data?.campusId ?? data?.campus_id ?? fallback.campusId,
    avatarUrl: data?.avatarUrl ?? data?.avatar_url ?? fallback.avatarUrl,
    bio: data?.bio ?? fallback.bio,
    relationshipStatus: data?.relationshipStatus ?? data?.relationship_status ?? fallback.relationshipStatus,
    profileCompleted: data?.profileCompleted ?? data?.profile_completed ?? fallback.profileCompleted,
    suspended: data?.suspended ?? fallback.suspended,
    privateAccount: Boolean(data?.privateAccount ?? fallback.privateAccount),
    privateAlias: data?.privateAlias ?? fallback.privateAlias,
    department: data?.department ?? fallback.department,
    level: data?.level ?? fallback.level,
    styleTags: Array.isArray(data?.styleTags)
      ? data.styleTags
      : Array.isArray(data?.style_tags)
      ? data.style_tags
      : fallback.styleTags,
  }
}

function formatCount(count) {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return `${count}`
}

function toMillis(value) {
  if (!value) return 0
  if (typeof value?.toMillis === 'function') return value.toMillis()
  if (typeof value === 'number') return value
  if (typeof value?.seconds === 'number') return value.seconds * 1000
  return 0
}

function formatRelativeTime(value) {
  const postedMs = toMillis(value)
  if (!postedMs) return 'now'
  const diffMs = Math.max(0, Date.now() - postedMs)
  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}hr`
}

function getSteezeTier(score) {
  if (score >= 6) return '👑 Standout'
  if (score >= 3) return '💎 Polished'
  if (score >= 1) return '🔥 Heating Up'
  return '🌱 Fresh'
}

function splitIntoChunks(items, size) {
  const chunks = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function validateMediaFile(file) {
  if (!file) return 'Select a file to upload.'
  const isImage = file.type.startsWith('image/')
  if (!isImage) return 'Only images are allowed.'
  if (file.size > maxImageBytes) {
    const mb = Math.round(maxImageBytes / (1024 * 1024))
    return `File too large. Max ${mb}MB.`
  }
  return ''
}

const safeUserMessages = [
  'Select a file to upload.',
  'Only images are allowed.',
  'Only images and videos are allowed.',
  'No file selected.',
  'File too large.',
  'File is too large.',
  'Write something before publishing.',
  'Add an image for reflection post.',
  'You must be logged in to upload media.',
  'Firebase is not configured.',
  'Firebase is not configured yet.',
]

function getFriendlyErrorMessage(error, context = 'general') {
  const fallbackByContext = {
    auth: 'Could not sign in. Please try again.',
    upload: 'Media upload failed. Please try again.',
    publish: 'Could not publish post. Please try again.',
    reaction: 'Could not save reaction.',
    comment: 'Could not add comment.',
    profile: 'Could not update profile.',
    settings: 'Could not save settings.',
    general: 'Something went wrong. Please try again.',
  }
  const rawMessage = String(error?.message || '').trim()
  const code = String(error?.code || '').trim().toLowerCase()
  const message = rawMessage || fallbackByContext[context] || fallbackByContext.general
  const lowerMessage = message.toLowerCase()

  if (safeUserMessages.some((text) => message.startsWith(text))) {
    return message
  }

  if (code.startsWith('auth/')) {
    switch (code) {
      case 'auth/email-already-in-use':
        return 'This email is already in use.'
      case 'auth/invalid-email':
        return 'Enter a valid email address.'
      case 'auth/weak-password':
        return 'Password should be at least 6 characters.'
      case 'auth/user-not-found':
      case 'auth/wrong-password':
        return 'Email or password is incorrect.'
      case 'auth/popup-closed-by-user':
        return 'Sign-in popup was closed.'
      case 'auth/network-request-failed':
        return 'Network error. Check your connection.'
      case 'auth/too-many-requests':
        return 'Too many attempts. Try again later.'
      case 'auth/operation-not-allowed':
        return "This sign-in method isn't enabled yet."
      case 'auth/invalid-credential':
        return 'Invalid credentials. Try again.'
      case 'auth/user-disabled':
        return 'Your account has been disabled.'
      default:
        return fallbackByContext.auth
    }
  }

  if (code === 'permission-denied' || lowerMessage.includes('permission') || lowerMessage.includes('insufficient')) {
    return 'You do not have permission to do that.'
  }
  if (code === 'unauthenticated') {
    return 'Please log in again and try.'
  }
  if (code === 'already-exists' || lowerMessage.includes('already exists')) {
    return 'That already exists.'
  }
  if (code === 'resource-exhausted' || lowerMessage.includes('quota')) {
    return 'Service is busy. Try again later.'
  }
  if (code === 'unavailable' || lowerMessage.includes('unavailable')) {
    return 'Service is temporarily unavailable.'
  }
  if (code === 'deadline-exceeded' || lowerMessage.includes('timeout')) {
    return 'Request timed out. Try again.'
  }
  if (lowerMessage.includes('network') || error?.name === 'AbortError') {
    return 'Network error. Check your connection.'
  }
  if (lowerMessage.includes('app check')) {
    return 'Uploads are unavailable right now.'
  }
  if (
    lowerMessage.includes('cloudinary') ||
    lowerMessage.includes('upload signature') ||
    lowerMessage.includes('sign upload') ||
    lowerMessage.includes('signature endpoint') ||
    lowerMessage.includes('upload failed')
  ) {
    return fallbackByContext.upload
  }
  if (lowerMessage.includes('firebase') || lowerMessage.includes('projects/')) {
    return fallbackByContext.general
  }
  if (message.includes('http://') || message.includes('https://')) {
    return fallbackByContext.general
  }

  return fallbackByContext[context] || fallbackByContext.general
}

function getFeedSnapshotMessage(error) {
  const raw = String(error?.message || '').toLowerCase()
  if (raw.includes('index')) {
    return 'Feed index missing. Deploy Firestore indexes then reload.'
  }
  return getFriendlyErrorMessage(error, 'general')
}

function Landing({
  mode,
  setMode,
  email,
  setEmail,
  password,
  setPassword,
  onSubmit,
  onGoogle,
  loading,
  message,
}) {
  const [hypeIndex, setHypeIndex] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setHypeIndex((prev) => (prev + 1) % hypeLines.length)
    }, 2600)
    return () => clearInterval(timer)
  }, [])

  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-10 text-zinc-100 sm:px-6 lg:px-10">
      <section className="mx-auto grid w-full max-w-6xl gap-8 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="grid gap-8">
          <div className="rounded-3xl border border-zinc-800 bg-hero-gradient p-6 sm:p-8">
            <p className="text-xs uppercase tracking-[0.32em] text-emerald-300">Mirror</p>
            <h1 className="mt-4 font-display text-4xl font-semibold leading-tight sm:text-6xl">Your Campus. Unfiltered.</h1>
            <p className="mt-4 max-w-xl text-base text-zinc-300 sm:text-lg">
              The real thoughts. The real drip. The real chaos.
              <br />
              All in one place.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3 text-sm text-zinc-300">
              <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-4 py-2">Enter Mirror</span>
              <span className="rounded-full border border-zinc-700 bg-zinc-900/60 px-4 py-2">See What’s Trending 🔥</span>
            </div>
            <div className="mt-6 text-xs text-zinc-400">
              <span key={hypeLines[hypeIndex]} className="typewriter">
                {hypeLines[hypeIndex]}
              </span>
            </div>
          </div>

          <div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6 sm:p-8">
            <p className="text-xs uppercase tracking-[0.3em] text-emerald-200/80">Identity hook</p>
            <h2 className="mt-3 font-display text-2xl font-semibold">Students don’t join platforms. They join identity.</h2>
            <div className="mt-4 grid gap-2 text-sm text-zinc-300">
              <p>Are you:</p>
              <p>The quiet observer?</p>
              <p>The fashion plug?</p>
              <p>The anonymous ranter?</p>
              <p>The streak grinder?</p>
              <p>The campus legend in progress?</p>
            </div>
            <p className="mt-4 text-sm text-emerald-200">Mirror shows who you really are.</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
              <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Today</p>
              <div className="mt-3 space-y-2 text-sm text-zinc-200">
                <p>🔥 248 posts today</p>
                <p>👀 1,204 reactions this week</p>
                <p>🎭 73 anonymous confessions</p>
                <p>🏆 19 students on fire streak</p>
              </div>
            </div>
            <div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
              <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Why Mirror</p>
              <p className="mt-3 text-sm text-zinc-200">
                You scroll Instagram. You watch TikTok.
                <br />
                But what’s happening on your campus?
              </p>
              <p className="mt-3 text-sm text-emerald-200">
                Mirror is built for your school. Not for influencers in LA. For you.
              </p>
            </div>
          </div>

          <div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6 sm:p-8">
            <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">What’s inside</p>
            <div className="mt-4 grid gap-2 text-sm text-zinc-200">
              <p>👤 Profiles that evolve</p>
              <p>🔥 Streaks that build status</p>
              <p>🎭 Anonymous rooms</p>
              <p>💬 Real comments, not fake hype</p>
              <p>👗 Outfit drops</p>
              <p>🏆 Leaderboards</p>
            </div>
          </div>

          <div className="rounded-3xl border border-emerald-500/30 bg-emerald-500/10 p-6 sm:p-8">
            <h2 className="font-display text-2xl font-semibold">Stop watching. Start being seen.</h2>
            <button type="button" className="mt-4 w-full rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950">
              Join Mirror
            </button>
          </div>
        </div>

        <aside className="auth-card rounded-3xl border border-zinc-800 p-6 sm:p-8">
          <div className="auth-inner">
            <div className="mb-4 flex rounded-full bg-zinc-950/80 p-1 text-xs">
              <button
                type="button"
                onClick={() => setMode('login')}
                className={`w-1/2 rounded-full px-3 py-2 ${mode === 'login' ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-300'}`}
              >
                Log in
              </button>
              <button
                type="button"
                onClick={() => setMode('signup')}
                className={`w-1/2 rounded-full px-3 py-2 ${mode === 'signup' ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-300'}`}
              >
                Sign up
              </button>
            </div>
            <form className="space-y-3" onSubmit={onSubmit}>
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="Email address"
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
              />
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Password"
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
              />
              <button
                type="submit"
                disabled={loading || !isFirebaseConfigured}
                className="w-full rounded-xl bg-emerald-500 px-3 py-2 text-sm font-medium text-zinc-950 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
              >
                {loading ? 'Please wait...' : mode === 'signup' ? 'Create account' : 'Login'}
              </button>
            </form>
            <button
              type="button"
              onClick={onGoogle}
              disabled={loading || !isFirebaseConfigured}
              className="mt-3 w-full rounded-xl border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm font-medium text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-500"
            >
              Continue with Google
            </button>
            {!isFirebaseConfigured && (
              <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                Missing Firebase env vars. Add them to `.env` then reload.
              </div>
            )}
            {message && <p className="mt-3 text-xs text-zinc-300">{message}</p>}
          </div>
        </aside>
      </section>
    </main>
  )
}
function App() {
  const [user, setUser] = useState(null)
  const [previewUser, setPreviewUser] = useState(null)
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('feed')
  const [activeMood, setActiveMood] = useState('Campus Pulse')
  const [selectedHashtag, setSelectedHashtag] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [settings, setSettings] = useState({
    privateAccount: false,
    showCampus: true,
    emailAlerts: true,
  })

  const [posts, setPosts] = useState([])
  const [feedVisibleCount, setFeedVisibleCount] = useState(feedPageSize)
  const [feedFetchLimit, setFeedFetchLimit] = useState(180)
  const [draftPost, setDraftPost] = useState(emptyPost)
  const [showComposer, setShowComposer] = useState(false)
  const [postMode, setPostMode] = useState('text')
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadStatus, setUploadStatus] = useState('')
  const [isPublishing, setIsPublishing] = useState(false)
  const [isSeeding, setIsSeeding] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [adminUsers, setAdminUsers] = useState([])
  const [adminPosts, setAdminPosts] = useState([])
  const [adminReports, setAdminReports] = useState([])
  const [adminIds, setAdminIds] = useState([])
  const [liveActivities, setLiveActivities] = useState([])
  const [copiedUid, setCopiedUid] = useState(false)
  const [rooms, setRooms] = useState([])
  const [selectedRoom, setSelectedRoom] = useState(null)
  const [roomPosts, setRoomPosts] = useState([])
  const [roomLoading, setRoomLoading] = useState(false)
  const [roomMessage, setRoomMessage] = useState('')
  const [roomRequestStatus, setRoomRequestStatus] = useState(null)
  const [roomRequests, setRoomRequests] = useState([])
  const [roomMembers, setRoomMembers] = useState([])
  const [roomDraft, setRoomDraft] = useState({ name: '', description: '', postTtl: 60 })
  const [roomPostDraft, setRoomPostDraft] = useState('')
  const [roomSearch, setRoomSearch] = useState('')
  const [showCreateRoom, setShowCreateRoom] = useState(false)
  const [canCreateRooms, setCanCreateRooms] = useState(false)
  const [isCreatingRoom, setIsCreatingRoom] = useState(false)
  const [isPostingRoom, setIsPostingRoom] = useState(false)

  const [selectedFile, setSelectedFile] = useState(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [_suggestedUsers, setSuggestedUsers] = useState([])
  const [reflectionCommentDrafts, setReflectionCommentDrafts] = useState({})
  const [reflectionCommentsPostId, setReflectionCommentsPostId] = useState(null)
  const [showAvatarModal, setShowAvatarModal] = useState(false)
  const [avatarModalUrl, setAvatarModalUrl] = useState('')
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [postUserProfiles, setPostUserProfiles] = useState({})
  const [deleteConfirmPostId, setDeleteConfirmPostId] = useState(null)
  const [postActionsPostId, setPostActionsPostId] = useState(null)
  const [actionToast, setActionToast] = useState(null)
  const [pendingReactions, setPendingReactions] = useState({})
  const [pendingComments, setPendingComments] = useState({})
  const [editProfileDraft, setEditProfileDraft] = useState({
    displayName: '',
    username: '',
    bio: '',
    department: '',
    level: '',
    relationshipStatus: '',
  })

  const baseProfile = {
    displayName: 'Mirror Student',
    username: '@mirrorstudent',
    campusId: defaultCampus,
    avatarUrl: '',
    bio: 'I post campus fit pictures.',
    styleTags: ['Streetwear', 'Corporate'],
    relationshipStatus: '',
    privateAccount: false,
    privateAlias: '',
    department: 'Computer Science',
    level: '100',
    profileCompleted: true,
    suspended: false,
  }

  const [profile, setProfile] = useState(baseProfile)
  const [followersCount, setFollowersCount] = useState(0)
  const [followingCount, setFollowingCount] = useState(0)
  const [followingIds, setFollowingIds] = useState([])
  const [followersList, setFollowersList] = useState([])
  const [followingList, setFollowingList] = useState([])
  const [networkView, setNetworkView] = useState(null)
  const [showEditProfileModal, setShowEditProfileModal] = useState(false)
  const [showSettingsModal, setShowSettingsModal] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [onboardingDraft, setOnboardingDraft] = useState({
    displayName: '',
    campusId: defaultCampus,
    relationshipStatus: 'single',
    department: 'Computer Science',
    level: '100',
  })

  const [profileViewId, setProfileViewId] = useState(null)
  const [profileView, setProfileView] = useState(null)
  const [profileViewPosts, setProfileViewPosts] = useState([])
  const [profileViewFollowers, setProfileViewFollowers] = useState(0)
  const [profileViewFollowing, setProfileViewFollowing] = useState(0)
  const [isFollowing, setIsFollowing] = useState(false)
  const [profileLoading, setProfileLoading] = useState(false)
  const centerScrollRef = useRef(null)
  const actionToastTimerRef = useRef(null)

  const currentUser = user ?? previewUser
  const currentUserId = currentUser?.uid || currentUser?.id
  const isAuthed = Boolean(currentUserId)
  const campusId = profile.campusId || defaultCampus
  const adminOwnerEmail = 'oluokundavid4@gmail.com'
  const isAdminOwnerEmail = (currentUser?.email || '').toLowerCase() === adminOwnerEmail
  const canUseAdminUI = isAdmin && isAdminOwnerEmail
  const deferredSearchQuery = useDeferredValue(searchQuery)

  useEffect(() => {
    if (activeTab === 'admin' && !canUseAdminUI) {
      setActiveTab('feed')
    }
  }, [activeTab, canUseAdminUI])

  useEffect(() => {
    if (!isFirebaseConfigured) return
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser)
    })
    return () => unsubscribe()
  }, [])

  useEffect(() => {
    return () => {
      if (actionToastTimerRef.current) {
        clearTimeout(actionToastTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!selectedFile) {
      setPreviewUrl('')
      return
    }
    const nextUrl = URL.createObjectURL(selectedFile)
    setPreviewUrl(nextUrl)
    return () => URL.revokeObjectURL(nextUrl)
  }, [selectedFile])

  useEffect(() => {
    if (!isAuthed || !isFirebaseConfigured || previewUser) return
    const profileRef = doc(db, 'users', currentUserId)
    let unsubscribe
    const isGoogleUser = Boolean(currentUser?.providerData?.some((item) => item.providerId === 'google.com'))

    const loadProfile = async () => {
      const existing = await getDoc(profileRef)
      if (!existing.exists()) {
        const displayName = currentUser?.displayName || baseProfile.displayName
        const safeName = currentUser?.email ? currentUser.email.split('@')[0] : 'mirrorstudent'
        const privateAlias = generatePrivateAlias(currentUserId)
        await setDoc(profileRef, {
          displayName,
          username: `@${safeName}`,
          campusId: defaultCampus,
          avatarUrl: currentUser?.photoURL || '',
          bio: baseProfile.bio,
          styleTags: baseProfile.styleTags,
          relationshipStatus: '',
          privateAccount: false,
          privateAlias,
          department: baseProfile.department,
          level: baseProfile.level,
          profileCompleted: !isGoogleUser,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      }
      unsubscribe = onSnapshot(profileRef, (snap) => {
        if (!snap.exists()) return
        const data = snap.data()
        const normalized = normalizeProfile(data, baseProfile)
        setProfile(normalized)
        setSettings((prev) => ({ ...prev, privateAccount: normalized.privateAccount }))
        if (!normalized.privateAlias && currentUserId) {
          setDoc(
            profileRef,
            {
              privateAlias: generatePrivateAlias(currentUserId),
              updatedAt: serverTimestamp(),
            },
            { merge: true },
          )
        }
        if (isGoogleUser && !normalized.profileCompleted) {
          setOnboardingDraft({
            displayName: normalized.displayName,
            campusId: normalized.campusId || defaultCampus,
            relationshipStatus: normalized.relationshipStatus || 'single',
            department: normalized.department || 'Computer Science',
            level: normalized.level || '100',
          })
          setShowOnboarding(true)
        }
      })
    }

    loadProfile()
    return () => unsubscribe?.()
  }, [isAuthed, currentUserId, previewUser])

  useEffect(() => {
    if (!isAuthed || !isFirebaseConfigured || previewUser) {
      setIsAdmin(false)
      return
    }
    const adminRef = doc(db, 'admins', currentUserId)
    const unsubscribe = onSnapshot(
      adminRef,
      (snap) => setIsAdmin(snap.exists()),
      () => setIsAdmin(false),
    )
    return () => unsubscribe()
  }, [isAuthed, currentUserId, previewUser])

  useEffect(() => {
    if (!isAdmin || !isFirebaseConfigured || previewUser) {
      setAdminUsers([])
      setAdminPosts([])
      setAdminReports([])
      setAdminIds([])
      return
    }

    const unsubUsers = onSnapshot(query(collection(db, 'users'), limit(250)), (snap) => {
      const rows = snap.docs.map((row) => ({ id: row.id, ...row.data() }))
      setAdminUsers(rows)
    })

    const unsubPosts = onSnapshot(query(collection(db, 'picture_posts'), orderBy('created_at', 'desc'), limit(250)), (snap) => {
      const rows = snap.docs.map((row) => ({ id: row.id, ...row.data() }))
      setAdminPosts(rows)
    })

    const unsubReports = onSnapshot(query(collection(db, 'post_reports'), orderBy('created_at', 'desc'), limit(250)), (snap) => {
      const rows = snap.docs.map((row) => ({ id: row.id, ...row.data() }))
      setAdminReports(rows)
    })

    const unsubAdmins = onSnapshot(query(collection(db, 'admins'), limit(250)), (snap) => {
      setAdminIds(snap.docs.map((row) => row.id))
    })

    return () => {
      unsubUsers()
      unsubPosts()
      unsubReports()
      unsubAdmins()
    }
  }, [isAdmin, previewUser])

  useEffect(() => {
    if (!isAuthed || !isFirebaseConfigured || previewUser) {
      setLiveActivities([])
      return
    }
    const activitiesQuery = query(collection(db, 'activities'), orderBy('created_at', 'desc'), limit(120))
    const unsubscribe = onSnapshot(activitiesQuery, (snap) => {
      const rows = snap.docs.map((row) => ({ id: row.id, ...row.data() }))
      setLiveActivities(rows)
    })
    return () => unsubscribe()
  }, [isAuthed, previewUser])

  useEffect(() => {
    if (!isAuthed || !isFirebaseConfigured || previewUser) return
    const postsRef = collection(db, 'picture_posts')
    const cutoffDate = new Date(Date.now() - feedWindowMs)
    const bucketState = {
      campus: [],
      mine: [],
      following: {},
      global: [],
    }

    const normalizePost = (docSnap) => {
      const data = docSnap.data()
      const reactionsCount = normalizeReactionCounts(data.reactions_count)
      const reactedBy = normalizeReactedBy(data.reacted_by)
      const fallbackLikes = data.likes_count || 0
      const fallbackLikedBy = Array.isArray(data.liked_by) ? data.liked_by : []
      const fallbackReactionCount = Math.max(fallbackLikes, fallbackLikedBy.length)
      if (!data.reactions_count && fallbackReactionCount > 0) {
        reactionsCount.thumbs_up = fallbackReactionCount
      }
      if (!data.reacted_by && fallbackLikedBy.length) {
        fallbackLikedBy.forEach((userId) => {
          if (userId && !reactedBy[userId]) reactedBy[userId] = 'thumbs_up'
        })
      }
      const engagementCount = data.engagement_count || computeReactionTotal(reactionsCount)
      return {
        id: docSnap.id,
        ...data,
        engagement_count: engagementCount,
        reactions_count: reactionsCount,
        reacted_by: reactedBy,
        comments_count: data.comments_count || 0,
        comments: Array.isArray(data.comments) ? data.comments : [],
        author_is_private: Boolean(data.author_is_private),
        author_private_alias: data.author_private_alias || '',
        author_display_name: data.author_display_name || '',
        steeze_score: data.steeze_score || 0,
        media_type: data.media_type || 'image',
        thumbnail_url: data.thumbnail_url || '',
        tags: Array.isArray(data.tags) ? data.tags : [],
        moderated_status: data.moderated_status || 'active',
        flags_count: data.flags_count || 0,
      }
    }

    const rankPosts = () => {
      const nowMs = Date.now()
      const styleSet = new Set((profile.styleTags || []).map((tag) => tag.toLowerCase()))
      const merged = new Map()
      const addToMerged = (row, source) => {
        const previous = merged.get(row.id)
        const next = {
          ...(previous || {}),
          ...row,
          _fromMine: previous?._fromMine || false,
          _fromFollowing: previous?._fromFollowing || false,
          _fromCampus: previous?._fromCampus || false,
          _fromGlobal: previous?._fromGlobal || false,
        }
        if (source === 'mine') next._fromMine = true
        if (source === 'following') next._fromFollowing = true
        if (source === 'campus') next._fromCampus = true
        if (source === 'global') next._fromGlobal = true
        merged.set(row.id, next)
      }

      bucketState.mine.forEach((row) => addToMerged(row, 'mine'))
      bucketState.campus.forEach((row) => addToMerged(row, 'campus'))
      Object.values(bucketState.following).forEach((rows) => rows.forEach((row) => addToMerged(row, 'following')))
      bucketState.global.forEach((row) => addToMerged(row, 'global'))

      const interactionTagWeights = new Map()
      const interactionAuthorWeights = new Map()
      Array.from(merged.values()).forEach((post) => {
        if (!post.reacted_by?.[currentUserId]) return
        interactionAuthorWeights.set(post.user_id, (interactionAuthorWeights.get(post.user_id) || 0) + 5)
        ;(post.tags || []).forEach((tag) => {
          const key = String(tag).toLowerCase()
          interactionTagWeights.set(key, (interactionTagWeights.get(key) || 0) + 2)
        })
      })

      const ranked = Array.from(merged.values())
        .filter((post) => {
          const createdMs = toMillis(post.created_at)
          return createdMs > 0 && nowMs - createdMs <= feedWindowMs
        })
        .map((post) => {
          const ageHours = Math.max(0, (nowMs - toMillis(post.created_at)) / 3600000)
          const recencyScore = Math.max(0, 24 - ageHours) * 4
          const engagementScore = (post.engagement_count || 0) * 2.2
          const styleScore = (post.tags || []).reduce((count, tag) => count + (styleSet.has(String(tag).toLowerCase()) ? 2 : 0), 0)
          const interactionScore = (post.tags || []).reduce(
            (total, tag) => total + (interactionTagWeights.get(String(tag).toLowerCase()) || 0),
            0,
          )
          const authorAffinity = interactionAuthorWeights.get(post.user_id) || 0
          const sourceBoost = (post._fromMine ? 120 : 0) + (post._fromFollowing ? 45 : 0) + (post._fromCampus ? 12 : 0) + (post._fromGlobal ? 6 : 0)
          return {
            ...post,
            _feedScore: sourceBoost + recencyScore + engagementScore + styleScore + interactionScore + authorAffinity,
          }
        })
        .sort((a, b) => b._feedScore - a._feedScore)
      setPosts(ranked)
    }

    const unsubs = []
    unsubs.push(
      onSnapshot(
        query(postsRef, where('campus_id', '==', campusId), where('created_at', '>=', cutoffDate), orderBy('created_at', 'desc'), limit(feedFetchLimit)),
        (snapshot) => {
          bucketState.campus = snapshot.docs.map(normalizePost)
          rankPosts()
        },
        (error) => {
          console.error('Campus feed snapshot error', error)
          setMessage(getFeedSnapshotMessage(error))
        },
      ),
    )

    unsubs.push(
      onSnapshot(
        query(postsRef, where('created_at', '>=', cutoffDate), orderBy('created_at', 'desc'), limit(feedFetchLimit)),
        (snapshot) => {
          bucketState.global = snapshot.docs.map(normalizePost)
          rankPosts()
        },
        (error) => {
          console.error('Global feed snapshot error', error)
          setMessage(getFeedSnapshotMessage(error))
        },
      ),
    )

    unsubs.push(
      onSnapshot(
        query(
          postsRef,
          where('user_id', '==', currentUserId),
          where('created_at', '>=', cutoffDate),
          orderBy('created_at', 'desc'),
          limit(Math.max(60, Math.floor(feedFetchLimit / 2))),
        ),
        (snapshot) => {
          bucketState.mine = snapshot.docs.map(normalizePost)
          rankPosts()
        },
        (error) => {
          console.error('My feed snapshot error', error)
          setMessage(getFeedSnapshotMessage(error))
        },
      ),
    )

    const followed = followingIds.filter((id) => id && id !== currentUserId).slice(0, 40)
    splitIntoChunks(followed, 10).forEach((chunk, index) => {
      unsubs.push(
        onSnapshot(
          query(
            postsRef,
            where('user_id', 'in', chunk),
            where('created_at', '>=', cutoffDate),
            orderBy('created_at', 'desc'),
            limit(Math.max(80, Math.floor(feedFetchLimit / 2))),
          ),
          (snapshot) => {
            bucketState.following[index] = snapshot.docs.map(normalizePost)
            rankPosts()
          },
          (error) => {
            console.error('Following feed snapshot error', error)
            setMessage(getFeedSnapshotMessage(error))
          },
        ),
      )
    })

    const rankTimer = setInterval(rankPosts, 30000)

    return () => {
      clearInterval(rankTimer)
      unsubs.forEach((unsubscribe) => unsubscribe())
    }
  }, [isAuthed, campusId, previewUser, currentUserId, followingIds, profile.styleTags, feedFetchLimit])

  useEffect(() => {
    if (!isAuthed || !isFirebaseConfigured || previewUser) return
    const followersQuery = query(collection(db, 'follows'), where('followingId', '==', currentUserId))
    const followingQuery = query(collection(db, 'follows'), where('followerId', '==', currentUserId))

    const unsubscribeFollowers = onSnapshot(followersQuery, async (snap) => {
      setFollowersCount(snap.size)
      const ids = snap.docs.map((row) => row.data().followerId).filter(Boolean)
      const users = await Promise.all(
        ids.map(async (id) => {
          const userSnap = await getDoc(doc(db, 'users', id))
          const data = userSnap.exists() ? userSnap.data() : {}
          return {
            id,
            displayName: data.displayName || 'Mirror Student',
            username: data.username || '@mirroruser',
          }
        }),
      )
      setFollowersList(users)
    })
    const unsubscribeFollowing = onSnapshot(followingQuery, async (snap) => {
      setFollowingCount(snap.size)
      const ids = snap.docs.map((row) => row.data().followingId).filter(Boolean)
      setFollowingIds(ids)
      const users = await Promise.all(
        ids.map(async (id) => {
          const userSnap = await getDoc(doc(db, 'users', id))
          const data = userSnap.exists() ? userSnap.data() : {}
          return {
            id,
            displayName: data.displayName || 'Mirror Student',
            username: data.username || '@mirroruser',
          }
        }),
      )
      setFollowingList(users)
    })

    return () => {
      unsubscribeFollowers()
      unsubscribeFollowing()
    }
  }, [isAuthed, currentUserId, previewUser, currentUser])

  useEffect(() => {
    if (!isAuthed || !isFirebaseConfigured || previewUser) return
    const usersQuery = query(collection(db, 'users'), limit(25))
    const unsubscribe = onSnapshot(usersQuery, (snapshot) => {
      const followingSet = new Set(followingIds)
      const rows = snapshot.docs
        .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
        .filter((row) => row.id !== currentUserId && !followingSet.has(row.id))
        .slice(0, 6)
        .map((row) => ({
          id: row.id,
          name: row.displayName || 'Student',
          handle: row.username || '@mirroruser',
        }))
      setSuggestedUsers(rows)
    })
    return () => unsubscribe()
  }, [isAuthed, currentUserId, followingIds, previewUser])

  useEffect(() => {
    if (!isAuthed || !isFirebaseConfigured || previewUser || !currentUser?.email) {
      setCanCreateRooms(false)
      return
    }
    if (isAdmin) {
      setCanCreateRooms(true)
      return
    }
    const emailKey = String(currentUser.email || '').trim().toLowerCase()
    if (!emailKey) {
      setCanCreateRooms(false)
      return
    }
    const creatorRef = doc(db, 'room_creators', emailKey)
    const unsubscribe = onSnapshot(
      creatorRef,
      (snap) => setCanCreateRooms(snap.exists()),
      () => setCanCreateRooms(false),
    )
    return () => unsubscribe()
  }, [isAuthed, previewUser, currentUser?.email, isAdmin])

  useEffect(() => {
    if (!isAuthed || !isFirebaseConfigured || previewUser) {
      setRooms([])
      return
    }
    const roomsQuery = query(collection(db, 'rooms'), orderBy('created_at', 'desc'), limit(80))
    const unsubscribe = onSnapshot(
      roomsQuery,
      (snap) => {
        const rows = snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
        setRooms(rows)
      },
      (error) => {
        console.error('Rooms snapshot error', error)
        setRoomMessage(getFriendlyErrorMessage(error, 'general'))
      },
    )
    return () => unsubscribe()
  }, [isAuthed, previewUser])

  useEffect(() => {
    if (!selectedRoom?.id || !isAuthed || !isFirebaseConfigured || previewUser) {
      setRoomPosts([])
      setRoomRequestStatus(null)
      setRoomRequests([])
      setRoomMembers([])
      return
    }
    setRoomLoading(true)
    const postQuery = query(
      collection(db, 'room_posts'),
      where('room_id', '==', selectedRoom.id),
      orderBy('created_at', 'desc'),
      limit(200),
    )
    const requestsQuery = query(
      collection(db, 'room_requests'),
      where('room_id', '==', selectedRoom.id),
      orderBy('created_at', 'desc'),
      limit(200),
    )
    const memberDocId = `${selectedRoom.id}_${currentUserId}`
    const memberRef = doc(db, 'room_members', memberDocId)

    const unsubPosts = onSnapshot(
      postQuery,
      (snap) => {
        const rows = snap.docs
          .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
          .filter((post) => {
            const expiresAt = toMillis(post.expires_at)
            return !expiresAt || expiresAt > Date.now()
          })
        setRoomPosts(rows)
        setRoomLoading(false)
      },
      (error) => {
        console.error('Room posts error', error)
        setRoomMessage(getFriendlyErrorMessage(error, 'general'))
        setRoomLoading(false)
      },
    )

    const unsubMember = onSnapshot(
      memberRef,
      (snap) => setRoomRequestStatus(snap.exists() ? 'approved' : null),
      () => setRoomRequestStatus(null),
    )

    const unsubRequests = onSnapshot(
      requestsQuery,
      (snap) => {
        const rows = snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
        setRoomRequests(rows)
        const myRequest = rows.find((row) => row.user_id === currentUserId)
        if (myRequest && myRequest.status && myRequest.status !== 'approved') {
          setRoomRequestStatus(myRequest.status)
        }
      },
      () => setRoomRequests([]),
    )

    const membersQuery = query(collection(db, 'room_members'), where('room_id', '==', selectedRoom.id), limit(300))
    const unsubMembers = onSnapshot(
      membersQuery,
      (snap) => setRoomMembers(snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))),
      () => setRoomMembers([]),
    )

    return () => {
      unsubPosts()
      unsubMember()
      unsubRequests()
      unsubMembers()
    }
  }, [selectedRoom?.id, isAuthed, currentUserId, previewUser])

  useEffect(() => {
    if (!profileViewId || !isFirebaseConfigured || previewUser) return
    setProfileLoading(true)
    const profileRef = doc(db, 'users', profileViewId)
    const postsRef = collection(db, 'picture_posts')
    const postsQuery = query(postsRef, where('user_id', '==', profileViewId), orderBy('created_at', 'desc'))
    const followersQuery = query(collection(db, 'follows'), where('followingId', '==', profileViewId))
    const followingQuery = query(collection(db, 'follows'), where('followerId', '==', profileViewId))

    const unsubProfile = onSnapshot(profileRef, (snap) => {
      if (!snap.exists()) return
      setProfileView(normalizeProfile(snap.data(), baseProfile))
      setProfileLoading(false)
    })

    const unsubPosts = onSnapshot(postsQuery, (snap) => {
      const rows = snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
      setProfileViewPosts(rows)
    })

    const unsubFollowers = onSnapshot(followersQuery, (snap) => setProfileViewFollowers(snap.size))
    const unsubFollowing = onSnapshot(followingQuery, (snap) => setProfileViewFollowing(snap.size))

    let unsubFollowState
    if (currentUserId && profileViewId && currentUserId !== profileViewId) {
      const followDoc = doc(db, 'follows', `${currentUserId}_${profileViewId}`)
      unsubFollowState = onSnapshot(followDoc, (snap) => setIsFollowing(snap.exists()))
    } else {
      setIsFollowing(false)
    }

    return () => {
      unsubProfile()
      unsubPosts()
      unsubFollowers()
      unsubFollowing()
      if (unsubFollowState) unsubFollowState()
    }
  }, [profileViewId, currentUserId, previewUser])

  useEffect(() => {
    if (!showEditProfileModal) return
    setEditProfileDraft({
      displayName: '',
      username: '',
      bio: '',
      department: profile.department || 'Computer Science',
      level: profile.level || '100',
      relationshipStatus: profile.relationshipStatus || 'single',
    })
  }, [showEditProfileModal, profile.department, profile.level, profile.relationshipStatus])

  const mySteezeAvg = useMemo(() => {
    if (!currentUserId) return 0
    const mine = posts.filter((post) => post.user_id === currentUserId)
    if (!mine.length) return 0
    const sum = mine.reduce((total, post) => total + (post.steeze_score || 0), 0)
    return Number((sum / mine.length).toFixed(1))
  }, [posts, currentUserId])

  const visiblePosts = useMemo(
    () => posts.filter((post) => isAdmin || (post.moderated_status || 'active') !== 'hidden'),
    [posts, isAdmin],
  )

  useEffect(() => {
    if (!isAuthed || !isFirebaseConfigured || previewUser) {
      setPostUserProfiles({})
      return
    }
    const userIds = Array.from(new Set(visiblePosts.map((post) => post.user_id).filter(Boolean))).slice(0, 200)
    if (userIds.length === 0) {
      setPostUserProfiles({})
      return
    }
    const unsubs = []
    splitIntoChunks(userIds, 10).forEach((chunk) => {
      const q = query(collection(db, 'users'), where(documentId(), 'in', chunk))
      const unsub = onSnapshot(q, (snap) => {
        setPostUserProfiles((prev) => {
          const next = { ...prev }
          snap.docs.forEach((docSnap) => {
            next[docSnap.id] = normalizeProfile(docSnap.data(), baseProfile)
          })
          return next
        })
      })
      unsubs.push(unsub)
    })
    return () => unsubs.forEach((unsub) => unsub())
  }, [visiblePosts, isAuthed, isFirebaseConfigured, previewUser, baseProfile])

  function resolvePostAuthor(post) {
    const latest = postUserProfiles[post.user_id]
    const postPrivacyKnown = typeof post.author_is_private === 'boolean'
    const isPrivate = postPrivacyKnown ? post.author_is_private : Boolean(latest?.privateAccount)
    const postLabel = post.author_display_name || post.author_private_alias || ''
    const postHandle = post.author_username || ''
    const postAvatar = post.author_avatar_url || ''
    if (isPrivate) {
      return {
        label: post.author_private_alias || latest?.privateAlias || generatePrivateAlias(post.user_id),
        handle: '@hidden',
        avatarUrl: '',
      }
    }
    return {
      label: postLabel || latest?.displayName || post.author_username || 'Mirror Student',
      handle: postHandle || latest?.username || '@mirrorstudent',
      avatarUrl: postAvatar || latest?.avatarUrl || '',
    }
  }
  const homePosts = useMemo(() => visiblePosts.filter((post) => (post.media_type || 'text') === 'text'), [visiblePosts])
  const reflectPosts = useMemo(() => visiblePosts.filter((post) => (post.media_type || 'text') !== 'text'), [visiblePosts])
  const trendingHashtags = useMemo(() => {
    const map = new Map()
    homePosts.forEach((post) => {
      const createdMs = toMillis(post.created_at)
      ;(post.tags || []).forEach((tagRaw) => {
        const tag = String(tagRaw || '').trim().toLowerCase()
        if (!tag) return
        const prev = map.get(tag) || { tag, count: 0, latestMs: 0 }
        prev.count += 1
        prev.latestMs = Math.max(prev.latestMs, createdMs)
        map.set(tag, prev)
      })
    })
    const rows = Array.from(map.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count
      return b.latestMs - a.latestMs
    })
    return rows.map((row) => row.tag)
  }, [homePosts])

  const moodItems = useMemo(() => {
    const trending = trendingHashtags.slice(0, 5)
    const tags = selectedHashtag && !trending.includes(selectedHashtag) ? [selectedHashtag, ...trending] : trending
    return [
      { id: 'pulse', label: 'Campus Pulse', kind: 'pulse' },
      { id: 'reflect', label: 'Reflect', kind: 'reflect' },
      ...tags.map((tag) => ({ id: `tag-${tag}`, label: `#${tag}`, kind: 'tag', tag })),
    ]
  }, [trendingHashtags, selectedHashtag])

  const moodFilteredHomePosts = useMemo(() => {
    if (!selectedHashtag) return homePosts
    return homePosts.filter((post) => (post.tags || []).map((tag) => String(tag).toLowerCase()).includes(selectedHashtag))
  }, [homePosts, selectedHashtag])

  const filteredPosts = useMemo(() => {
    const queryText = deferredSearchQuery.trim().toLowerCase()
    if (!queryText) return homePosts
    return homePosts.filter((post) => {
      const haystack = [
        post.caption || '',
        post.author_display_name || '',
        post.author_username || '',
        ...(Array.isArray(post.tags) ? post.tags : []),
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(queryText)
    })
  }, [homePosts, deferredSearchQuery])

  const filteredRooms = useMemo(() => {
    const queryText = roomSearch.trim().toLowerCase()
    if (!queryText) return rooms
    return rooms.filter((room) => {
      const haystack = `${room.name || ''} ${room.description || ''}`.toLowerCase()
      return haystack.includes(queryText)
    })
  }, [rooms, roomSearch])

  const visibleFeedPosts = useMemo(() => moodFilteredHomePosts.slice(0, feedVisibleCount), [moodFilteredHomePosts, feedVisibleCount])

  function loadMoreFeed() {
    setFeedVisibleCount((prev) => {
      const next = Math.min(moodFilteredHomePosts.length, prev + feedPageSize)
      if (next >= moodFilteredHomePosts.length - 2) {
        setFeedFetchLimit((limitValue) => Math.min(1200, limitValue + 120))
      }
      return next
    })
  }

  function handleCenterScroll(event) {
    if (activeTab !== 'feed') return
    const target = event.currentTarget
    const threshold = 260
    if (target.scrollHeight - target.scrollTop - target.clientHeight <= threshold) {
      loadMoreFeed()
    }
  }

  useEffect(() => {
    setFeedVisibleCount((prev) => {
      if (moodFilteredHomePosts.length === 0) return 0
      const baseline = prev > 0 ? prev : feedPageSize
      return Math.min(moodFilteredHomePosts.length, Math.max(feedPageSize, baseline))
    })
  }, [moodFilteredHomePosts.length])

  useEffect(() => {
    if (activeTab !== 'feed') return
    const onWindowScroll = () => {
      const threshold = 260
      const pageBottom = window.innerHeight + window.scrollY
      const fullHeight = document.documentElement.scrollHeight
      if (fullHeight - pageBottom <= threshold) {
        loadMoreFeed()
      }
    }
    window.addEventListener('scroll', onWindowScroll, { passive: true })
    return () => window.removeEventListener('scroll', onWindowScroll)
  }, [activeTab, moodFilteredHomePosts.length])

  async function handleAuth(event) {
    event.preventDefault()
    setMessage('')
    if (!isFirebaseConfigured) {
      setMessage('Firebase is not configured yet.')
      return
    }
    setLoading(true)
    try {
      if (mode === 'signup') {
        await createUserWithEmailAndPassword(auth, email, password)
        setMessage('Account created. Welcome!')
      } else {
        await signInWithEmailAndPassword(auth, email, password)
        setMessage('Welcome back.')
      }
      setPassword('')
    } catch (error) {
      console.error('Auth error', error)
      setMessage(getFriendlyErrorMessage(error, 'auth'))
    } finally {
      setLoading(false)
    }
  }

  async function handleGoogleAuth() {
    setMessage('')
    if (!isFirebaseConfigured) {
      setMessage('Firebase is not configured yet.')
      return
    }
    setLoading(true)
    try {
      await signInWithPopup(auth, googleProvider)
      setMessage('Welcome back.')
    } catch (error) {
      console.error('Google auth error', error)
      const code = String(error?.code || '').toLowerCase()
      if (
        code === 'auth/popup-blocked' ||
        code === 'auth/popup-closed-by-user' ||
        code === 'auth/operation-not-supported-in-this-environment'
      ) {
        try {
          await signInWithRedirect(auth, googleProvider)
          setMessage('Continue in the new tab to sign in.')
          return
        } catch (redirectError) {
          console.error('Google redirect error', redirectError)
          setMessage(getFriendlyErrorMessage(redirectError, 'auth'))
        }
      } else {
        setMessage(getFriendlyErrorMessage(error, 'auth'))
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleMediaPick(event) {
    const file = event.target.files?.[0]
    if (!file) return
    const validation = validateMediaFile(file)
    if (validation) {
      setMessage(validation)
      return
    }
    setSelectedFile(file)
    setUploadProgress(0)
    setUploadStatus('')
  }

  async function uploadMedia(file) {
    if (!file) return null
    const authToken = auth.currentUser ? await getIdToken(auth.currentUser) : null
    const appCheckToken = await getAppCheckToken()
    if (!authToken) {
      throw new Error('You must be logged in to upload media.')
    }
    if (!appCheckToken && !shouldBypassAppCheck) {
      throw new Error('App Check is not configured. Add VITE_FIREBASE_APPCHECK_SITE_KEY.')
    }

    const result = await uploadToCloudinarySigned(file, {
      folder: 'mirror',
      authToken,
      appCheckToken,
      onProgress: (percent) => setUploadProgress(percent),
    })

    return {
      url: result.secureUrl,
      publicId: result.publicId,
      mediaType: result.resourceType,
    }
  }

  async function logActivity(activity) {
    if (!isFirebaseConfigured || previewUser || !currentUserId) return
    await addDoc(collection(db, 'activities'), {
      actor_id: currentUserId,
      actor_username: profile.username || '@mirroruser',
      actor_avatar_url: profile.avatarUrl || '',
      campus_id: campusId,
      created_at: serverTimestamp(),
      ...activity,
    })
  }

  function assertCanInteract() {
    if (profile.suspended) {
      setMessage('Your account is currently suspended.')
      return false
    }
    return true
  }

  function showActionToast(text) {
    if (actionToastTimerRef.current) {
      clearTimeout(actionToastTimerRef.current)
    }
    setActionToast(text)
    actionToastTimerRef.current = setTimeout(() => {
      setActionToast(null)
      actionToastTimerRef.current = null
    }, 1000)
  }

  function buildPostAuthorFields() {
    const privateAlias = profile.privateAlias || generatePrivateAlias(currentUserId)
    if (settings.privateAccount) {
      return {
        author_username: '@hidden',
        author_display_name: privateAlias,
        author_private_alias: privateAlias,
        author_is_private: true,
        author_avatar_url: '',
      }
    }
    return {
      author_username: profile.username || '@mirrorstudent',
      author_display_name: profile.displayName || 'Mirror Student',
      author_private_alias: '',
      author_is_private: false,
      author_avatar_url: profile.avatarUrl || '',
    }
  }

  async function createPost(event) {
    event.preventDefault()
    if (!currentUserId || isPublishing) return
    if (!assertCanInteract()) return

    if (!draftPost.caption.trim()) {
      setMessage('Write something before publishing.')
      return
    }
    if (postMode === 'reflection' && !selectedFile) {
      setMessage('Add an image for reflection post.')
      return
    }

    let mediaUrl = ''
    let mediaType = postMode === 'reflection' ? 'image' : 'text'
    let thumbnailUrl = ''
    let publicId = ''

    setIsPublishing(true)

    const reactionsCount = createEmptyReactionCounts()
    const engagementCount = 0
    const extractedTags = Array.from(new Set((draftPost.caption.match(/#([a-zA-Z0-9_]+)/g) || []).map((item) => item.replace('#', ''))))
    const steeze = computeSteezeScore({
      engagementCount,
    })
    const authorFields = buildPostAuthorFields()

    const tempId = `local-post-${Date.now()}`
    const optimisticPost = {
      id: tempId,
      user_id: currentUserId,
      image_url: previewUrl || '',
      caption: draftPost.caption.trim(),
      tags: extractedTags,
      engagement_count: engagementCount,
      reactions_count: reactionsCount,
      reacted_by: {},
      comments_count: 0,
      comments: [],
      views_count: 0,
      steeze_score: steeze,
      campus_id: campusId,
      ...authorFields,
      media_type: mediaType,
      thumbnail_url: thumbnailUrl,
      public_id: publicId,
      moderated_status: 'active',
      flags_count: 0,
      created_at: Date.now(),
      delivery_status: 'sending',
    }
    setPosts((prev) => [optimisticPost, ...prev])
    setShowComposer(false)

    if (selectedFile) {
      try {
        setUploading(true)
        setUploadStatus('Uploading media...')
        const uploaded = await uploadMedia(selectedFile)
        if (!uploaded) {
          setIsPublishing(false)
          return
        }
        mediaUrl = uploaded.url
        mediaType = uploaded.mediaType
        thumbnailUrl = ''
        publicId = uploaded.publicId
        setPosts((prev) =>
          prev.map((post) =>
            post.id === tempId
              ? {
                  ...post,
                  image_url: mediaUrl,
                  media_type: mediaType,
                  thumbnail_url: thumbnailUrl,
                  public_id: publicId,
                }
              : post,
          ),
        )
        setUploadStatus('Upload complete.')
      } catch (error) {
        console.error('Upload error', error)
        setPosts((prev) => prev.filter((post) => post.id !== tempId))
        setMessage(getFriendlyErrorMessage(error, 'upload'))
        setUploading(false)
        setIsPublishing(false)
        return
      } finally {
        setUploading(false)
      }
    }

    const postPayload = {
      user_id: currentUserId,
      image_url: mediaUrl,
      caption: draftPost.caption.trim(),
      tags: extractedTags,
      engagement_count: engagementCount,
      reactions_count: reactionsCount,
      reacted_by: {},
      comments_count: 0,
      comments: [],
      views_count: 0,
      steeze_score: steeze,
      campus_id: campusId,
      ...authorFields,
      media_type: mediaType,
      thumbnail_url: thumbnailUrl,
      public_id: publicId,
      moderated_status: 'active',
      flags_count: 0,
    }

    try {
      if (isFirebaseConfigured && !previewUser) {
        const docRef = await addDoc(collection(db, 'picture_posts'), {
          ...postPayload,
          created_at: serverTimestamp(),
        })
        await logActivity({
          type: 'post_created',
          post_id: docRef.id,
          post_user_id: currentUserId,
        })
        setPosts((prev) =>
          prev.map((post) =>
            post.id === tempId
              ? {
                  ...post,
                  id: docRef.id,
                  delivery_status: 'sent',
                }
              : post,
          ),
        )
      }
      setDraftPost(emptyPost)
      setSelectedFile(null)
      setPreviewUrl('')
      setShowComposer(false)
      showActionToast('Post sent.')
      setUploadProgress(0)
      setUploadStatus('')
    } catch (error) {
      setPosts((prev) =>
        prev.map((post) =>
          post.id === tempId
            ? {
                ...post,
                delivery_status: 'failed',
              }
            : post,
        ),
      )
      console.error('Publish error', error)
      setMessage(getFriendlyErrorMessage(error, 'publish'))
    } finally {
      setIsPublishing(false)
    }
  }

  async function reactToPost(postId, reactionKey) {
    if (!reactionKeys.includes(reactionKey)) return
    const target = posts.find((post) => post.id === postId)
    if (!target || !currentUserId) return
    if (!assertCanInteract()) return
    if (pendingReactions[postId]) return
    const currentReactedBy = normalizeReactedBy(target.reacted_by)
    const currentReactionsCount = normalizeReactionCounts(target.reactions_count)
    const currentReaction = currentReactedBy[currentUserId] || null
    const isRemoving = currentReaction === reactionKey
    const nextReaction = isRemoving ? null : reactionKey
    const nextReactedBy = { ...currentReactedBy }
    if (isRemoving) {
      delete nextReactedBy[currentUserId]
    } else {
      nextReactedBy[currentUserId] = reactionKey
    }
    const nextReactionsCount = { ...currentReactionsCount }
    if (currentReaction && nextReactionsCount[currentReaction] > 0) {
      nextReactionsCount[currentReaction] -= 1
    }
    if (nextReaction) {
      nextReactionsCount[nextReaction] += 1
    }
    const nextEngagement = computeReactionTotal(nextReactionsCount)
    const nextSteeze = computeSteezeScore({
      engagementCount: nextEngagement,
    })

    setPendingReactions((prev) => ({ ...prev, [postId]: true }))

    setPosts((prev) =>
      prev.map((post) =>
        post.id === postId
          ? {
              ...post,
              reacted_by: nextReactedBy,
              reactions_count: nextReactionsCount,
              engagement_count: nextEngagement,
              steeze_score: nextSteeze,
            }
          : post,
      ),
    )

    try {
      if (isFirebaseConfigured && !previewUser) {
        const postRef = doc(db, 'picture_posts', postId)
        await runTransaction(db, async (transaction) => {
          const snap = await transaction.get(postRef)
          if (!snap.exists()) return
          const data = snap.data()
          const dbReactedBy = normalizeReactedBy(data.reacted_by)
          const dbReactionsCount = normalizeReactionCounts(data.reactions_count)
          const dbCurrentReaction = dbReactedBy[currentUserId] || null
          const dbRemoving = dbCurrentReaction === reactionKey
          const dbNextReaction = dbRemoving ? null : reactionKey
          if (dbCurrentReaction && dbReactionsCount[dbCurrentReaction] > 0) {
            dbReactionsCount[dbCurrentReaction] -= 1
          }
          if (dbNextReaction) {
            dbReactionsCount[dbNextReaction] += 1
            dbReactedBy[currentUserId] = dbNextReaction
          } else {
            delete dbReactedBy[currentUserId]
          }
          const updatedEngagement = computeReactionTotal(dbReactionsCount)
          const updatedSteeze = computeSteezeScore({
            engagementCount: updatedEngagement,
          })
          transaction.update(postRef, {
            engagement_count: updatedEngagement,
            reactions_count: dbReactionsCount,
            reacted_by: dbReactedBy,
            steeze_score: updatedSteeze,
          })
        })
        if (!isRemoving) {
          await logActivity({
            type: 'post_reacted',
            post_id: postId,
            post_user_id: target.user_id,
            reaction_key: reactionKey,
          })
        }
      }
    } catch (error) {
      setPosts((prev) =>
        prev.map((post) =>
          post.id === postId
            ? {
                ...post,
                reacted_by: currentReactedBy,
                reactions_count: currentReactionsCount,
                engagement_count: target.engagement_count || computeReactionTotal(currentReactionsCount),
                steeze_score: target.steeze_score || computeSteezeScore({ engagementCount: computeReactionTotal(currentReactionsCount) }),
              }
            : post,
        ),
      )
      console.error('Reaction error', error)
      setMessage(getFriendlyErrorMessage(error, 'reaction'))
    } finally {
      setPendingReactions((prev) => {
        const next = { ...prev }
        delete next[postId]
        return next
      })
    }
  }

  async function addReflectionComment(postId) {
    const target = posts.find((post) => post.id === postId)
    if (!target || target.media_type === 'text') return
    if (!assertCanInteract()) return
    if (pendingComments[postId]) return
    const text = (reflectionCommentDrafts[postId] || '').trim()
    if (!text || !currentUserId) return

    const commentAuthorName = settings.privateAccount
      ? profile.privateAlias || generatePrivateAlias(currentUserId)
      : profile.displayName || profile.username || 'Mirror Student'
    const commentAuthorHandle = settings.privateAccount ? '@hidden' : profile.username || '@mirrorstudent'
    const commentAvatar = settings.privateAccount ? '' : profile.avatarUrl || ''
    const nextComment = {
      id: `${currentUserId}-${Date.now()}`,
      user_id: currentUserId,
      text: text.slice(0, 220),
      author_name: commentAuthorName,
      author_handle: commentAuthorHandle,
      author_avatar_url: commentAvatar,
      created_at: Date.now(),
    }

    setPosts((prev) =>
      prev.map((post) =>
        post.id === postId
          ? {
              ...post,
              comments: [...(post.comments || []), nextComment],
              comments_count: (post.comments_count || 0) + 1,
            }
          : post,
      ),
    )
    showActionToast('Comment added.')
    setReflectionCommentDrafts((prev) => ({ ...prev, [postId]: '' }))

    setPendingComments((prev) => ({ ...prev, [postId]: true }))
    try {
      if (isFirebaseConfigured && !previewUser) {
        const postRef = doc(db, 'picture_posts', postId)
        await runTransaction(db, async (transaction) => {
          const snap = await transaction.get(postRef)
          if (!snap.exists()) return
          const data = snap.data()
          if ((data.media_type || 'text') === 'text') return
          const comments = Array.isArray(data.comments) ? data.comments : []
          const updatedComments = [...comments, nextComment].slice(-150)
          transaction.update(postRef, {
            comments: updatedComments,
            comments_count: updatedComments.length,
          })
        })
      }
    } catch (error) {
      console.error('Comment error', error)
      setMessage(getFriendlyErrorMessage(error, 'comment'))
    } finally {
      setPendingComments((prev) => {
        const next = { ...prev }
        delete next[postId]
        return next
      })
    }
  }

  async function saveProfile(event) {
    event.preventDefault()
    if (!currentUserId) return
    const nextDisplayName = editProfileDraft.displayName.trim() || profile.displayName
    const nextUsername = editProfileDraft.username.trim() || profile.username
    const nextBio = editProfileDraft.bio.trim() || profile.bio
    const nextDepartment = editProfileDraft.department || profile.department || 'Computer Science'
    const nextLevel = editProfileDraft.level || profile.level || '100'
    const nextRelationshipStatus = editProfileDraft.relationshipStatus || profile.relationshipStatus || 'single'
    setProfile((prev) => ({
      ...prev,
      displayName: nextDisplayName,
      username: nextUsername,
      bio: nextBio,
      department: nextDepartment,
      level: nextLevel,
      relationshipStatus: nextRelationshipStatus,
    }))
    if (isFirebaseConfigured && !previewUser) {
      const profileRef = doc(db, 'users', currentUserId)
      await setDoc(
        profileRef,
        {
          displayName: nextDisplayName,
          username: nextUsername,
          campusId: profile.campusId,
          avatarUrl: profile.avatarUrl,
          bio: nextBio,
          relationshipStatus: nextRelationshipStatus,
          privateAccount: settings.privateAccount,
          privateAlias: profile.privateAlias || generatePrivateAlias(currentUserId),
          department: nextDepartment,
          level: nextLevel,
          profileCompleted: profile.profileCompleted,
          styleTags: profile.styleTags,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      )
    }
    setMessage('Profile saved.')
  }

  async function removeProfileAvatar() {
    if (!currentUserId) return
    setProfile((prev) => ({ ...prev, avatarUrl: '' }))
    if (isFirebaseConfigured && !previewUser) {
      await setDoc(
        doc(db, 'users', currentUserId),
        {
          avatarUrl: '',
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      )
    }
    setMessage('Profile photo removed.')
  }

  async function followUser(targetId) {
    if (!currentUserId || !targetId || previewUser) return
    if (!isFirebaseConfigured) return
    if (!assertCanInteract()) return
    const followDoc = doc(db, 'follows', `${currentUserId}_${targetId}`)
    await setDoc(followDoc, {
      followerId: currentUserId,
      followingId: targetId,
      createdAt: serverTimestamp(),
    })
  }

  async function unfollowUser(targetId) {
    if (!currentUserId || !targetId || previewUser) return
    if (!isFirebaseConfigured) return
    const followDoc = doc(db, 'follows', `${currentUserId}_${targetId}`)
    await deleteDoc(followDoc)
  }

  async function reportPost(postId) {
    if (!currentUserId || !isFirebaseConfigured || previewUser) return
    if (!assertCanInteract()) return
    const reportId = `${postId}_${currentUserId}`
    await setDoc(
      doc(db, 'post_reports', reportId),
      {
        post_id: postId,
        reporter_id: currentUserId,
        status: 'open',
        created_at: serverTimestamp(),
        updated_at: serverTimestamp(),
      },
      { merge: true },
    )
    showActionToast('Report submitted.')
  }

  function canDeletePost(post) {
    if (!post || !currentUserId) return false
    return isAdmin || post.user_id === currentUserId
  }

  async function deletePost(postId) {
    const target = posts.find((post) => post.id === postId)
    if (!target || !canDeletePost(target)) return
    setDeleteConfirmPostId(null)
    const previousPosts = posts
    setPosts((prev) => prev.filter((post) => post.id !== postId))
    if (!isFirebaseConfigured || previewUser) {
      showActionToast('Post deleted.')
      return
    }
    try {
      await deleteDoc(doc(db, 'picture_posts', postId))
      showActionToast('Post deleted.')
    } catch (error) {
      setPosts(previousPosts)
      console.error('Delete post error', error)
      setMessage(getFriendlyErrorMessage(error, 'publish'))
    }
  }

  async function setPostModerationStatus(postId, status) {
    if (!isAdmin || !isFirebaseConfigured || previewUser) return
    await updateDoc(doc(db, 'picture_posts', postId), {
      moderated_status: status,
      moderated_at: serverTimestamp(),
      moderated_by: currentUserId,
    })
  }

  async function removePostAsAdmin(postId) {
    if (!isAdmin || !isFirebaseConfigured || previewUser) return
    await deleteDoc(doc(db, 'picture_posts', postId))
  }

  async function resolveReport(reportId) {
    if (!isAdmin || !isFirebaseConfigured || previewUser) return
    await updateDoc(doc(db, 'post_reports', reportId), {
      status: 'resolved',
      updated_at: serverTimestamp(),
      handled_by: currentUserId,
    })
  }

  async function setUserSuspension(targetId, suspended) {
    if (!isAdmin || !isFirebaseConfigured || previewUser || !targetId) return
    await updateDoc(doc(db, 'users', targetId), {
      suspended,
      updatedAt: serverTimestamp(),
    })
  }

  async function grantAdmin(targetId) {
    if (!isAdmin || !isFirebaseConfigured || previewUser || !targetId) return
    await setDoc(
      doc(db, 'admins', targetId),
      {
        createdAt: serverTimestamp(),
        createdBy: currentUserId,
      },
      { merge: true },
    )
  }

  async function revokeAdmin(targetId) {
    if (!isAdmin || !isFirebaseConfigured || previewUser || !targetId || targetId === currentUserId) return
    await deleteDoc(doc(db, 'admins', targetId))
  }

  async function signOut() {
    if (previewUser) {
      setPreviewUser(null)
      return
    }
    await firebaseSignOut(auth)
  }

  async function copyMyUid() {
    if (!currentUserId) return
    try {
      await navigator.clipboard.writeText(currentUserId)
      setCopiedUid(true)
      setTimeout(() => setCopiedUid(false), 1500)
    } catch {
      setMessage('Could not copy UID. Copy it manually from this page.')
    }
  }

  async function saveSettings() {
    if (!currentUserId || !isFirebaseConfigured || previewUser) {
      setMessage('Settings saved.')
      return
    }
    await setDoc(
      doc(db, 'users', currentUserId),
      {
        privateAccount: settings.privateAccount,
        privateAlias: profile.privateAlias || generatePrivateAlias(currentUserId),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    )
    setMessage('Settings saved.')
  }

  async function saveOnboarding(event) {
    event.preventDefault()
    if (!currentUserId || !isFirebaseConfigured || previewUser) return
    const profileRef = doc(db, 'users', currentUserId)
    await setDoc(
      profileRef,
      {
        displayName: onboardingDraft.displayName.trim() || profile.displayName,
        campusId: onboardingDraft.campusId.trim() || defaultCampus,
        relationshipStatus: onboardingDraft.relationshipStatus,
        department: onboardingDraft.department || 'Computer Science',
        level: onboardingDraft.level || '100',
        privateAlias: profile.privateAlias || generatePrivateAlias(currentUserId),
        profileCompleted: true,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    )
    setShowOnboarding(false)
    setMessage('Profile updated.')
  }

  async function createRoom(event) {
    event.preventDefault()
    if (!currentUserId || !currentUser?.email || !isFirebaseConfigured || previewUser) return
    if (isCreatingRoom) return
    const name = roomDraft.name.trim()
    if (!name) {
      setRoomMessage('Room name is required.')
      return
    }
    setIsCreatingRoom(true)
    setRoomMessage('')
    try {
      const payload = {
        name: name.slice(0, 60),
        description: roomDraft.description.trim().slice(0, 240),
        owner_id: currentUserId,
        owner_email: String(currentUser.email || '').trim().toLowerCase(),
        join_mode: 'request',
        post_ttl_minutes: Number(roomDraft.postTtl) || 60,
        created_at: serverTimestamp(),
      }
      const docRef = await addDoc(collection(db, 'rooms'), payload)
      setRoomDraft({ name: '', description: '', postTtl: 60 })
      setShowCreateRoom(false)
      setSelectedRoom({ id: docRef.id, ...payload, created_at: Date.now() })
      showActionToast('Room created.')
    } catch (error) {
      console.error('Create room error', error)
      setRoomMessage(getFriendlyErrorMessage(error, 'general'))
    } finally {
      setIsCreatingRoom(false)
    }
  }

  async function requestRoomJoin(roomId) {
    if (!currentUserId || !roomId || !isFirebaseConfigured || previewUser) return
    if (roomRequestStatus === 'pending') return
    try {
      const requestId = `${roomId}_${currentUserId}`
      await setDoc(
        doc(db, 'room_requests', requestId),
        {
          room_id: roomId,
          user_id: currentUserId,
          status: 'pending',
          created_at: serverTimestamp(),
          updated_at: serverTimestamp(),
        },
        { merge: true },
      )
      setRoomRequestStatus('pending')
      showActionToast('Request sent.')
    } catch (error) {
      console.error('Request join error', error)
      setRoomMessage(getFriendlyErrorMessage(error, 'general'))
    }
  }

  async function handleRoomRequest(requestId, status) {
    if (!selectedRoom?.id || !requestId || !isFirebaseConfigured || previewUser) return
    try {
      const reqRef = doc(db, 'room_requests', requestId)
      await updateDoc(reqRef, {
        status,
        updated_at: serverTimestamp(),
      })
      const [roomId, userId] = requestId.split('_')
      if (status === 'approved' && roomId && userId) {
        await setDoc(
          doc(db, 'room_members', `${roomId}_${userId}`),
          {
            room_id: roomId,
            user_id: userId,
            joined_at: serverTimestamp(),
          },
          { merge: true },
        )
      }
    } catch (error) {
      console.error('Handle request error', error)
      setRoomMessage(getFriendlyErrorMessage(error, 'general'))
    }
  }

  async function postToRoom(event) {
    event.preventDefault()
    if (!selectedRoom?.id || !currentUserId || !isFirebaseConfigured || previewUser) return
    if (isPostingRoom) return
    if (roomRequestStatus !== 'approved') {
      setRoomMessage('You need approval to post in this room.')
      return
    }
    const text = roomPostDraft.trim()
    if (!text) return
    setIsPostingRoom(true)
    setRoomMessage('')
    const alias = generateRoomAlias(selectedRoom.id, currentUserId)
    const expiresMs = Date.now() + (Number(selectedRoom.post_ttl_minutes || 60) * 60 * 1000)
    try {
      await addDoc(collection(db, 'room_posts'), {
        room_id: selectedRoom.id,
        user_id: currentUserId,
        text: text.slice(0, 500),
        alias,
        created_at: serverTimestamp(),
        expires_at: new Date(expiresMs),
      })
      setRoomPostDraft('')
      showActionToast('Post sent.')
    } catch (error) {
      console.error('Room post error', error)
      setRoomMessage(getFriendlyErrorMessage(error, 'general'))
    } finally {
      setIsPostingRoom(false)
    }
  }

  async function uploadProfileAvatar(event) {
    if (avatarUploading) return
    const file = event.target.files?.[0]
    if (!file) return
    const validation = validateMediaFile(file)
    if (validation) {
      setMessage(validation)
      return
    }
    try {
      setAvatarUploading(true)
      const uploaded = await uploadMedia(file)
      if (!uploaded?.url) return
      setProfile((prev) => ({ ...prev, avatarUrl: uploaded.url }))
      if (currentUserId && isFirebaseConfigured && !previewUser) {
        await setDoc(
          doc(db, 'users', currentUserId),
          {
            avatarUrl: uploaded.url,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        )
      }
      setMessage('Profile photo updated.')
    } catch (error) {
      console.error('Avatar upload error', error)
      setMessage(getFriendlyErrorMessage(error, 'upload'))
    } finally {
      setAvatarUploading(false)
    }
  }

  function openAvatarModal(url) {
    if (!url) return
    setAvatarModalUrl(url)
    setShowAvatarModal(true)
  }

  async function seedRandomPosts() {
    if (isSeeding) return
    if (!assertCanInteract()) return
    if (!currentUserId) {
      setMessage('You need to be signed in to populate feed.')
      return
    }
    if (!isFirebaseConfigured) {
      setMessage('Firebase is not configured.')
      return
    }
    if (previewUser) {
      setMessage('Populate feed is disabled in preview mode.')
      return
    }
    setIsSeeding(true)
    setMessage('')
    try {
      const openers = ['No cap', 'Lowkey', 'Abeg', 'Honestly', 'Real talk', 'Campus gist', 'Omo', 'Bro', 'At this point']
      const cores = [
        'who dey organize this timetable',
        'this lecturer no de smile at all',
        'hostel light vanished again',
        'who has the exam past question pdf',
        'cafeteria queue is wild today',
        'department group chat is boiling',
        'this rain ruined my whole plan',
        'project deadline is chasing me',
        'attendance policy is stressful',
        'library vibes tonight are elite',
      ]
      const endings = ['fr', 'sha', 'please', 'any updates?', 'make we talk true', 'no be joke', 'who else?', 'this thing weak me']
      const tags = ['campus', 'gist', 'exam', 'hostel', 'schoollife', 'ngcampus', 'studentlife', 'naija']
      const campuses = [campusId, 'UNILAG', 'UI', 'UNN', 'OAU', 'LASU', 'UNIBEN']
      const count = 30
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

      for (let index = 0; index < count; index += 1) {
        const rawCaption = `${openers[Math.floor(Math.random() * openers.length)]} ${cores[Math.floor(Math.random() * cores.length)]} ${
          endings[Math.floor(Math.random() * endings.length)]
        } #${tags[Math.floor(Math.random() * tags.length)]}`
        const caption = rawCaption.slice(0, 210)
        const randomHours = Math.random() * 24
        const createdAt = new Date(Date.now() - randomHours * 60 * 60 * 1000)
        const reactionsCount = createEmptyReactionCounts()
        const views = 0
        const engagementCount = 0
        const steeze = computeSteezeScore({ engagementCount })
        const extractedTags = Array.from(new Set((caption.match(/#([a-zA-Z0-9_]+)/g) || []).map((item) => item.replace('#', ''))))
        await addDoc(collection(db, 'picture_posts'), {
          user_id: currentUserId,
          image_url: '',
          caption,
          tags: extractedTags,
          engagement_count: engagementCount,
          reactions_count: reactionsCount,
          reacted_by: {},
          comments_count: 0,
          comments: [],
          views_count: views,
          steeze_score: steeze,
          campus_id: campuses[Math.floor(Math.random() * campuses.length)],
          author_username: profile.username || '@mirrorstudent',
          author_display_name: profile.displayName || 'Mirror Student',
          author_private_alias: '',
          author_is_private: false,
          author_avatar_url: '',
          media_type: 'text',
          thumbnail_url: '',
          public_id: '',
          moderated_status: 'active',
          flags_count: 0,
          created_at: new Date(createdAt.getTime() - index * 1000),
        })
        if (index % 5 === 0) await delay(120)
      }
      setMessage('Random posts added to feed.')
    } catch (error) {
      const text = String(error?.message || '')
      if (text.toLowerCase().includes('permission') || text.toLowerCase().includes('insufficient')) {
        setMessage('Missing or insufficient permissions. Deploy latest Firestore rules, then try again.')
      } else {
        console.error('Seed error', error)
        setMessage(getFriendlyErrorMessage(error, 'general'))
      }
    } finally {
      setIsSeeding(false)
    }
  }

  function openUserProfile(userId) {
    if (!userId) return
    setNetworkView(null)
    setProfileViewId(userId)
    setActiveTab('profile')
  }

  if (!isAuthed) {
    return (
      <Landing
        mode={mode}
        setMode={setMode}
        email={email}
        setEmail={setEmail}
        password={password}
        setPassword={setPassword}
        onSubmit={handleAuth}
        onGoogle={handleGoogleAuth}
        loading={loading}
        message={message}
      />
    )
  }

  const navItems = [
    { label: 'Home', id: 'feed' },
    { label: 'Reflect', id: 'reflect' },
    { label: 'Rooms', id: 'rooms' },
    { label: 'Explore', id: 'search' },
    { label: 'Profile', id: 'profile' },
    ...(canUseAdminUI ? [{ label: 'Admin', id: 'admin' }] : []),
  ]

  const mobileNavItems = [
    { id: 'feed', label: 'Home' },
    { id: 'reflect', label: 'Reflect' },
    { id: 'rooms', label: 'Rooms' },
    { id: 'post', label: 'Post' },
    { id: 'search', label: 'Search' },
    { id: 'profile', label: 'Profile' },
    ...(canUseAdminUI ? [{ id: 'admin', label: 'Admin' }] : []),
  ]

  const canPublish = !uploading && !isPublishing && Boolean(draftPost.caption.trim()) && (postMode === 'text' || Boolean(selectedFile))
  const isViewingOtherProfile = Boolean(profileViewId && profileViewId !== currentUserId)
  const pageTitle =
    activeTab === 'reflect'
      ? 'Reflect'
      : activeTab === 'rooms'
      ? 'Anonymous Rooms'
      : activeTab === 'search'
      ? 'Explore'
      : activeTab === 'admin' && canUseAdminUI
      ? 'Admin'
      : activeTab === 'feed' && selectedHashtag
      ? `#${selectedHashtag}`
      : activeTab === 'profile'
      ? 'Profile'
      : 'Campus Pulse'

  return (
    <main className={`min-h-screen overflow-x-hidden px-3 pb-24 pt-4 text-zinc-100 sm:px-6 lg:h-screen lg:overflow-hidden lg:px-8 lg:pb-6 ${activeTab === 'reflect' ? 'bg-zinc-950' : 'bg-zinc-950'}`}>
      <div className="mx-auto grid w-full max-w-6xl gap-4 lg:h-full lg:grid-cols-[68px_minmax(0,1fr)_260px]">
        <aside className="hidden items-center gap-3 rounded-3xl border border-zinc-800 bg-zinc-900/60 py-4 lg:flex lg:h-[calc(100vh-3rem)] lg:flex-col">
          <p className="text-[10px] uppercase tracking-[0.3em] text-zinc-500">MM</p>
          <nav className="space-y-2">
            {navItems.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => {
                  setActiveTab(item.id)
                  if (item.id !== 'profile') setProfileViewId(null)
                }}
                className={`grid h-10 w-10 place-items-center rounded-xl border ${
                  activeTab === item.id ? 'border-emerald-500/70 bg-emerald-500/10 text-emerald-100' : 'border-zinc-800 bg-zinc-900/40 text-zinc-400'
                }`}
                aria-label={item.label}
              >
                {item.id === 'feed' && '⌂'}
                {item.id === 'reflect' && '◉'}
                {item.id === 'rooms' && '◈'}
                {item.id === 'search' && '⌕'}
                {item.id === 'profile' && '◌'}
                {item.id === 'admin' && '⚙'}
              </button>
            ))}
          </nav>
          <button
            type="button"
            onClick={() => {
              setPostMode(activeTab === 'reflect' ? 'reflection' : 'text')
              setShowComposer(true)
            }}
            className="mt-2 grid h-10 w-10 place-items-center rounded-xl bg-emerald-500 text-zinc-950"
          >
            +
          </button>
          <div className="mt-auto w-full px-2">
            <button
              type="button"
              onClick={() => {
                setProfileViewId(null)
                setActiveTab('profile')
              }}
              className="grid h-10 w-10 place-items-center rounded-xl border border-zinc-800 bg-zinc-900/40 text-zinc-300"
            >
              ☺
            </button>
          </div>
        </aside>

        <section ref={centerScrollRef} onScroll={handleCenterScroll} className="min-w-0 space-y-4 lg:h-[calc(100vh-3rem)] lg:overflow-y-auto lg:px-2 no-scrollbar">
          <header className="sticky top-0 z-20 rounded-2xl border border-zinc-800 bg-zinc-900/90 p-3 backdrop-blur sm:p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">For you</p>
                <h1 className="font-display text-2xl font-semibold">{pageTitle}</h1>
              </div>
              <div className="hidden items-center gap-2 sm:flex lg:hidden">
                <button
                  type="button"
                  onClick={() => setActiveTab('feed')}
                  className={`rounded-full px-4 py-2 text-xs font-semibold ${
                    activeTab === 'feed' ? 'bg-emerald-500 text-zinc-950' : 'border border-zinc-700 text-zinc-200'
                  }`}
                >
                  Home
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setProfileViewId(null)
                    setActiveTab('profile')
                  }}
                  className={`rounded-full px-4 py-2 text-xs font-semibold ${
                    activeTab === 'profile' ? 'bg-emerald-500 text-zinc-950' : 'border border-zinc-700 text-zinc-200'
                  }`}
                >
                  Me
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPostMode(activeTab === 'reflect' ? 'reflection' : 'text')
                    setShowComposer(true)
                  }}
                  className="rounded-full bg-emerald-500 px-4 py-2 text-xs font-semibold text-zinc-950"
                >
                  Post
                </button>
                {activeTab === 'feed' && (
                  <button
                    type="button"
                    onClick={seedRandomPosts}
                    disabled={isSeeding}
                    className="rounded-full border border-zinc-700 px-4 py-2 text-xs font-semibold text-zinc-200 disabled:opacity-60"
                  >
                    {isSeeding ? 'Populating...' : 'Populate'}
                  </button>
                )}
              </div>
            </div>
            <div className="mt-3 flex gap-2 overflow-x-auto no-scrollbar">
              {moodItems.map((mood) => (
                <button
                  key={mood.id}
                  type="button"
                  onClick={() => {
                    setActiveMood(mood.label)
                    if (mood.kind === 'reflect') {
                      setSelectedHashtag('')
                      setActiveTab('reflect')
                      return
                    }
                    setActiveTab('feed')
                    if (mood.kind === 'pulse') {
                      setSelectedHashtag('')
                      return
                    }
                    setSelectedHashtag(mood.tag || '')
                  }}
                  className={`shrink-0 rounded-full border px-3 py-1 text-xs ${
                    activeMood === mood.label ? 'border-emerald-500/70 bg-emerald-500/10 text-emerald-100' : 'border-zinc-800 text-zinc-400'
                  }`}
                >
                  {mood.label}
                </button>
              ))}
            </div>
          </header>

          {message && <p className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-300">{message}</p>}
          {actionToast && (
            <div className="fixed right-4 top-4 z-50 rounded-xl border border-emerald-500/50 bg-emerald-500/15 px-4 py-3 text-xs text-emerald-100 shadow-[0_0_20px_rgba(16,185,129,0.35)]">
              <p className="font-semibold">Action completed</p>
              <p className="mt-0.5">{actionToast}</p>
            </div>
          )}
          {profile.suspended && (
            <p className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              Account suspended. You can browse but cannot post, react, or follow.
            </p>
          )}

          {activeTab === 'feed' && (
            <section className="space-y-3">
              <button
                type="button"
                onClick={() => setShowComposer(true)}
                className="w-full rounded-2xl border border-zinc-800 bg-zinc-900/80 px-4 py-3 text-left text-sm text-zinc-400"
              >
                What's happening on campus?
              </button>
              {visibleFeedPosts.map((post) => {
                const myReaction = post.reacted_by?.[currentUserId] || null
                const reactionsCount = normalizeReactionCounts(post.reactions_count)
                const hashtagText = (post.tags || []).map((tag) => `#${tag}`).join(' ')
                const author = resolvePostAuthor(post)
                const isReacting = Boolean(pendingReactions[post.id])
                return (
                  <article key={post.id} className="overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-900/70">
                    <div className="flex items-center justify-between gap-3 px-4 py-3">
                      <button type="button" onClick={() => openUserProfile(post.user_id)} className="flex items-center gap-3 text-left">
                        {author.avatarUrl ? (
                          <img src={author.avatarUrl} alt="Author" className="h-10 w-10 rounded-full object-cover" />
                        ) : (
                          <div className="grid h-10 w-10 place-items-center rounded-full bg-zinc-700 text-xs font-semibold">
                            {author.label
                              .split(' ')
                              .map((part) => part[0] || '')
                              .join('')
                              .slice(0, 2)
                              .toUpperCase()}
                          </div>
                        )}
                        <div>
                          <p className="text-sm font-semibold text-zinc-100">{author.label}</p>
                          <p className="text-[11px] text-zinc-400">{author.handle}</p>
                          <p className="text-xs text-zinc-500">
                            {(post.campus_id || campusId).toUpperCase()} · {formatRelativeTime(post.created_at)}
                          </p>
                        </div>
                      </button>
                      {post.delivery_status === 'sending' && (
                        <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">Sending…</span>
                      )}
                      {post.delivery_status === 'failed' && (
                        <span className="rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">Send failed</span>
                      )}
                    </div>

                    <div className="space-y-3 px-4 pb-4">
                      <p className="text-[15px] leading-7 text-zinc-100">
                        {post.caption}{' '}
                        {hashtagText && <span className="text-emerald-300/90">{hashtagText}</span>}
                      </p>
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        {reactionTypes.map((reaction) => (
                          <button
                            key={`${post.id}-${reaction.key}`}
                            type="button"
                            onClick={() => reactToPost(post.id, reaction.key)}
                            disabled={isReacting}
                            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 transition ${
                              myReaction === reaction.key ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-100' : 'border-zinc-700 text-zinc-200'
                            } ${isReacting ? 'opacity-60' : ''}`}
                          >
                            <span>{reaction.emoji}</span>
                            <span>{reactionsCount[reaction.key] || 0}</span>
                          </button>
                        ))}
                        <div className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 px-3 py-1.5 text-zinc-500">
                          <span>⚡</span>
                          <span>{post.engagement_count || 0}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setPostActionsPostId(post.id)}
                          className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-zinc-800 px-3 py-1.5 text-zinc-500"
                        >
                          <span>⋮</span>
                        </button>
                      </div>
                    </div>
                  </article>
                )
              })}
              {visibleFeedPosts.length < moodFilteredHomePosts.length && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-center text-xs text-zinc-400">Scroll to load more posts...</div>
              )}
              {moodFilteredHomePosts.length > 0 && visibleFeedPosts.length >= moodFilteredHomePosts.length && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-center text-xs text-zinc-500">Loading more campus posts...</div>
              )}
            </section>
          )}

          {activeTab === 'reflect' && (
            <section className="space-y-4">
              {reflectPosts.length === 0 && (
                <div className="grid min-h-[55vh] place-items-center rounded-3xl border border-zinc-800 bg-zinc-900/60 p-8 text-center">
                  <div>
                    <p className="text-sm text-zinc-400">No reflections yet.</p>
                    <button
                      type="button"
                      onClick={() => {
                        setPostMode('reflection')
                        setShowComposer(true)
                      }}
                      className="mt-3 rounded-full bg-emerald-500 px-4 py-2 text-xs font-semibold text-zinc-950"
                    >
                      Add Reflection
                    </button>
                  </div>
                </div>
              )}
              {reflectPosts.map((post) => (
                <article key={post.id} className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900">
                  {(() => {
                    const author = resolvePostAuthor(post)
                    const isReacting = Boolean(pendingReactions[post.id])
                    const isCommenting = Boolean(pendingComments[post.id])
                    return (
                  <div className="grid lg:grid-cols-2">
                    <div className="relative h-[56vh] w-full bg-zinc-950 sm:h-[66vh] lg:h-[72vh]">
                      {post.image_url ? (
                        <img src={post.image_url} alt="Reflection" className="h-full w-full object-cover object-top" />
                      ) : (
                        <div className="grid h-full w-full place-items-center p-8 text-center text-sm text-zinc-500">Reflection preview unavailable.</div>
                      )}
                      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-zinc-950/80 via-zinc-950/10 to-transparent" />
                      <button
                        type="button"
                        onClick={() => openUserProfile(post.user_id)}
                        className="absolute left-4 top-4 rounded-full bg-zinc-950/60 px-3 py-1 text-xs text-zinc-100"
                      >
                        {author.label} · {formatRelativeTime(post.created_at)}
                      </button>
                      {post.delivery_status === 'sending' && (
                        <span className="absolute right-4 top-4 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                          Sending…
                        </span>
                      )}
                      {post.delivery_status === 'failed' && (
                        <span className="absolute right-4 top-4 rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">
                          Send failed
                        </span>
                      )}
                      <div className="absolute left-4 bottom-4 max-w-[90%] space-y-2">
                        <p className="text-sm text-zinc-100">{post.caption}</p>
                        {getSteezeTier(post.steeze_score || 0) !== '🌱 Fresh' && (
                          <span className="inline-block rounded-full bg-zinc-950/70 px-3 py-1 text-xs text-emerald-200">
                            {getSteezeTier(post.steeze_score || 0)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex h-full flex-col gap-3 p-4">
                      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 pb-3 text-xs">
                        {reactionTypes.map((reaction) => (
                          <button
                            key={`reflect-${post.id}-${reaction.key}`}
                            type="button"
                            onClick={() => reactToPost(post.id, reaction.key)}
                            disabled={isReacting}
                            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1.5 ${
                              post.reacted_by?.[currentUserId] === reaction.key ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-100' : 'border-zinc-700 text-zinc-200'
                            } ${isReacting ? 'opacity-60' : ''}`}
                          >
                            <span>{reaction.emoji}</span>
                            <span>{normalizeReactionCounts(post.reactions_count)[reaction.key] || 0}</span>
                          </button>
                        ))}
                        <span className="ml-auto rounded-full border border-zinc-700 px-2.5 py-1 text-zinc-300">Steeze {post.steeze_score || 0}</span>
                        <button type="button" onClick={() => setPostActionsPostId(post.id)} className="rounded-full border border-zinc-700 px-2.5 py-1 text-zinc-300">
                          ⋮
                        </button>
                      </div>
                      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                        <div className="lg:hidden">
                          {(post.comments || []).length === 0 && <p className="text-xs text-zinc-500">No comments yet.</p>}
                          {(post.comments || []).length > 0 && (
                            <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2">
                              {(() => {
                                const latest = [...(post.comments || [])].sort((a, b) => toMillis(b.created_at) - toMillis(a.created_at))[0]
                                return (
                                  <div className="flex items-start gap-2">
                                    {latest.author_avatar_url ? (
                                      <img src={latest.author_avatar_url} alt="Comment author" className="mt-0.5 h-7 w-7 rounded-full object-cover" />
                                    ) : (
                                      <div className="grid h-7 w-7 place-items-center rounded-full bg-zinc-700 text-[10px] font-semibold text-zinc-200">
                                        {(latest.author_name || 'M').slice(0, 1).toUpperCase()}
                                      </div>
                                    )}
                                    <div className="min-w-0">
                                      <button type="button" onClick={() => latest.user_id && openUserProfile(latest.user_id)} className="text-xs font-semibold text-zinc-200">
                                        {latest.author_name || 'Mirror Student'}
                                      </button>
                                      <p className="text-[11px] text-zinc-500">{latest.author_handle || ''}</p>
                                      <p className="mt-1 text-xs text-zinc-300">{latest.text}</p>
                                    </div>
                                  </div>
                                )
                              })()}
                            </div>
                          )}
                          {(post.comments || []).length > 1 && (
                            <button
                              type="button"
                              onClick={() => setReflectionCommentsPostId(post.id)}
                              className="mt-2 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300"
                            >
                              View comments ({post.comments_count || post.comments.length})
                            </button>
                          )}
                        </div>
                        <div className="hidden lg:block">
                          {(post.comments || []).length === 0 && <p className="text-xs text-zinc-500">No comments yet.</p>}
                          {(post.comments || []).map((comment) => (
                            <div key={comment.id || `${post.id}-${comment.user_id}-${comment.created_at}`} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2">
                              <div className="flex items-start gap-2">
                                {comment.author_avatar_url ? (
                                  <img src={comment.author_avatar_url} alt="Comment author" className="mt-0.5 h-7 w-7 rounded-full object-cover" />
                                ) : (
                                  <div className="grid h-7 w-7 place-items-center rounded-full bg-zinc-700 text-[10px] font-semibold text-zinc-200">
                                    {(comment.author_name || 'M').slice(0, 1).toUpperCase()}
                                  </div>
                                )}
                                <div className="min-w-0">
                                  <button type="button" onClick={() => comment.user_id && openUserProfile(comment.user_id)} className="text-xs font-semibold text-zinc-200">
                                    {comment.author_name || 'Mirror Student'}
                                  </button>
                                  <p className="text-[11px] text-zinc-500">{comment.author_handle || ''}</p>
                                  <p className="mt-1 text-xs text-zinc-300">{comment.text}</p>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          value={reflectionCommentDrafts[post.id] || ''}
                          onChange={(event) => setReflectionCommentDrafts((prev) => ({ ...prev, [post.id]: event.target.value }))}
                          placeholder="Comment on this reflection..."
                          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => addReflectionComment(post.id)}
                          disabled={isCommenting}
                          className={`rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-zinc-950 ${isCommenting ? 'opacity-60' : ''}`}
                        >
                          {isCommenting ? 'Sending...' : 'Send'}
                        </button>
                      </div>
                    </div>
                  </div>
                    )
                  })()}
                </article>
              ))}
            </section>
          )}

          {activeTab === 'rooms' && (
            <section className="space-y-4">
              <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
                <div className="min-w-0 flex-1">
                  <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Anonymous Rooms</p>
                  <p className="mt-2 text-sm text-zinc-300">Request access, post anonymously, and let your room expire the posts.</p>
                </div>
                {canCreateRooms && (
                  <button
                    type="button"
                    onClick={() => setShowCreateRoom(true)}
                    className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-xs font-semibold text-emerald-100"
                  >
                    Create room
                  </button>
                )}
              </div>

              {roomMessage && <p className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-300">{roomMessage}</p>}

              <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
                <aside className="space-y-2 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-3">
                  <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Rooms</p>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">
                    <input
                      value={roomSearch}
                      onChange={(event) => setRoomSearch(event.target.value)}
                      placeholder="Search rooms..."
                      className="w-full bg-transparent text-sm text-zinc-200 outline-none"
                    />
                  </div>
                  {filteredRooms.length === 0 && <p className="text-xs text-zinc-500">No rooms found.</p>}
                  {filteredRooms.map((room) => (
                    <button
                      key={room.id}
                      type="button"
                      onClick={() => setSelectedRoom(room)}
                      className={`w-full rounded-xl border px-3 py-2 text-left text-sm ${
                        selectedRoom?.id === room.id ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-100' : 'border-zinc-800 text-zinc-300'
                      }`}
                    >
                      <p className="font-semibold text-zinc-100">{room.name}</p>
                      <p className="text-xs text-zinc-500">{room.description || 'Anonymous space'}</p>
                      <p className="mt-1 text-[11px] text-zinc-500">TTL: {room.post_ttl_minutes || 60}m</p>
                    </button>
                  ))}
                </aside>

                <div className="min-h-[40vh] rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                  {!selectedRoom && <p className="text-sm text-zinc-400">Pick a room to see posts.</p>}
                  {selectedRoom && (
                    <div className="space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Room</p>
                          <h3 className="text-lg font-semibold text-zinc-100">{selectedRoom.name}</h3>
                          <p className="text-xs text-zinc-400">{selectedRoom.description || 'Anonymous room'}</p>
                        </div>
                        <div className="text-xs text-zinc-500">
                          {roomMembers.length} members · TTL {selectedRoom.post_ttl_minutes || 60}m
                        </div>
                      </div>

                      {roomRequestStatus !== 'approved' && (
                        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300">
                          {roomRequestStatus === 'pending' && <p>Your request is pending approval.</p>}
                          {roomRequestStatus === 'rejected' && <p>Your request was rejected.</p>}
                          {!roomRequestStatus && (
                            <button
                              type="button"
                              onClick={() => requestRoomJoin(selectedRoom.id)}
                              className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-100"
                            >
                              Request to join
                            </button>
                          )}
                        </div>
                      )}

                      <div className="space-y-2">
                        {roomLoading && <p className="text-xs text-zinc-500">Loading posts...</p>}
                        {!roomLoading && roomPosts.length === 0 && <p className="text-xs text-zinc-500">No posts yet.</p>}
                        {roomPosts.map((post) => (
                          <article key={post.id} className="post-enter rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-200">
                            <div className="flex items-center justify-between text-xs text-zinc-500">
                              <span>{post.alias}</span>
                              <span>{formatRelativeTime(post.created_at)}</span>
                            </div>
                            <p className="mt-2 text-sm text-zinc-100">{post.text}</p>
                          </article>
                        ))}
                      </div>

                      {roomRequestStatus === 'approved' && (
                        <form onSubmit={postToRoom} className="flex flex-wrap items-end gap-2 rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                          <div className="flex-1">
                            <p className="text-[11px] text-zinc-500">Posting as {generateRoomAlias(selectedRoom.id, currentUserId)}</p>
                            <textarea
                              value={roomPostDraft}
                              onChange={(event) => setRoomPostDraft(event.target.value)}
                              placeholder="Drop your anonymous thought..."
                              rows={3}
                              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
                            />
                          </div>
                          <button
                            type="submit"
                            disabled={isPostingRoom}
                            className={`rounded-full bg-emerald-500 px-4 py-2 text-xs font-semibold text-zinc-950 ${isPostingRoom ? 'opacity-60' : ''}`}
                          >
                            {isPostingRoom ? 'Sending...' : 'Post'}
                          </button>
                        </form>
                      )}

                      {selectedRoom.owner_id === currentUserId && roomRequests.length > 0 && (
                        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                          <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Join requests</p>
                          <div className="mt-2 space-y-2">
                            {roomRequests
                              .filter((req) => req.status === 'pending')
                              .map((req) => (
                                <div key={req.id} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs">
                                  <span className="text-zinc-300">{req.user_id}</span>
                                  <div className="flex gap-2">
                                    <button
                                      type="button"
                                      onClick={() => handleRoomRequest(req.id, 'approved')}
                                      className="rounded-full border border-emerald-500/40 px-3 py-1 text-emerald-200"
                                    >
                                      Approve
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleRoomRequest(req.id, 'rejected')}
                                      className="rounded-full border border-rose-500/40 px-3 py-1 text-rose-200"
                                    >
                                      Reject
                                    </button>
                                  </div>
                                </div>
                              ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}

          {activeTab === 'search' && (
            <section className="grid gap-4">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                <div className="flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-950 px-4 py-2 text-sm text-zinc-300">
                  <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current text-zinc-500">
                    <path d="M10 2a8 8 0 1 1-5.29 14l-2.7 2.7a1 1 0 1 1-1.42-1.4l2.7-2.71A8 8 0 0 1 10 2zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12z" />
                  </svg>
                  <input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search outfits, hashtags, events, users..."
                    className="w-full bg-transparent text-sm outline-none"
                  />
                </div>
              </div>
              <div className="space-y-3">
                {filteredPosts.length === 0 && <p className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-400">No results found.</p>}
                {filteredPosts.map((post) => (
                  <article key={post.id} className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                    <div className="flex items-center justify-between">
                      <button type="button" onClick={() => openUserProfile(post.user_id)} className="text-sm font-semibold text-zinc-100">
                        {resolvePostAuthor(post).label}
                      </button>
                      <p className="text-xs text-zinc-500">{formatRelativeTime(post.created_at)}</p>
                    </div>
                    <p className="mt-2 text-sm text-zinc-200">{post.caption}</p>
                    <p className="mt-2 text-xs text-emerald-300">{(post.tags || []).map((tag) => `#${tag}`).join(' ')}</p>
                  </article>
                ))}
              </div>
            </section>
          )}

          {activeTab === 'admin' && canUseAdminUI && (
            <section className="grid gap-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                  <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Users</p>
                  <p className="mt-2 text-2xl font-semibold text-zinc-100">{formatCount(adminUsers.length)}</p>
                </div>
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                  <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Posts</p>
                  <p className="mt-2 text-2xl font-semibold text-zinc-100">{formatCount(adminPosts.length)}</p>
                </div>
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                  <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Open Reports</p>
                  <p className="mt-2 text-2xl font-semibold text-amber-300">{formatCount(adminReports.filter((report) => report.status !== 'resolved').length)}</p>
                </div>
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                <p className="text-sm font-semibold text-zinc-100">Moderation Queue</p>
                <div className="mt-3 space-y-2">
                  {adminReports.filter((report) => report.status !== 'resolved').slice(0, 20).map((report) => (
                    <div key={report.id} className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                      <p className="text-xs text-zinc-400">Post: {report.post_id}</p>
                      <p className="text-xs text-zinc-500">Reporter: {report.reporter_id}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button type="button" onClick={() => setPostModerationStatus(report.post_id, 'hidden')} className="rounded-full border border-rose-500/40 px-3 py-1 text-xs text-rose-200">
                          Hide Post
                        </button>
                        <button type="button" onClick={() => setPostModerationStatus(report.post_id, 'active')} className="rounded-full border border-emerald-500/40 px-3 py-1 text-xs text-emerald-200">
                          Restore
                        </button>
                        <button type="button" onClick={() => removePostAsAdmin(report.post_id)} className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-200">
                          Delete
                        </button>
                        <button type="button" onClick={() => resolveReport(report.id)} className="rounded-full bg-emerald-500 px-3 py-1 text-xs font-semibold text-zinc-950">
                          Resolve
                        </button>
                      </div>
                    </div>
                  ))}
                  {adminReports.filter((report) => report.status !== 'resolved').length === 0 && (
                    <p className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-400">No open reports.</p>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                <p className="text-sm font-semibold text-zinc-100">User Management</p>
                <div className="mt-3 space-y-2">
                  {adminUsers.slice(0, 30).map((entry) => {
                    const entryIsAdmin = adminIds.includes(entry.id)
                    return (
                      <div key={entry.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                        <div>
                          <p className="text-sm font-semibold text-zinc-100">{entry.displayName || 'Mirror Student'}</p>
                          <p className="text-xs text-zinc-400">{entry.username || '@mirroruser'}</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => setUserSuspension(entry.id, !entry.suspended)}
                            className={`rounded-full border px-3 py-1 text-xs ${entry.suspended ? 'border-emerald-500/40 text-emerald-200' : 'border-rose-500/40 text-rose-200'}`}
                          >
                            {entry.suspended ? 'Unsuspend' : 'Suspend'}
                          </button>
                          <button type="button" onClick={() => openUserProfile(entry.id)} className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-200">
                            View
                          </button>
                          {entryIsAdmin ? (
                            <button
                              type="button"
                              onClick={() => revokeAdmin(entry.id)}
                              disabled={entry.id === currentUserId}
                              className="rounded-full border border-amber-500/40 px-3 py-1 text-xs text-amber-200 disabled:opacity-40"
                            >
                              Revoke Admin
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => grantAdmin(entry.id)}
                              className="rounded-full border border-emerald-500/40 px-3 py-1 text-xs text-emerald-200"
                            >
                              Make Admin
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </section>
          )}

          {activeTab === 'profile' && (
            <section className="grid gap-4">
              {isViewingOtherProfile && profileView && (
                <>
                  <article className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        {profileView.avatarUrl ? (
                          <button type="button" onClick={() => openAvatarModal(profileView.avatarUrl)} className="rounded-full">
                            <img src={profileView.avatarUrl} alt="Profile" className="h-14 w-14 rounded-full object-cover" />
                          </button>
                        ) : (
                          <div className="grid h-14 w-14 place-items-center rounded-full bg-zinc-700 text-sm font-semibold">
                            {profileView.displayName
                              .split(' ')
                              .map((part) => part[0] || '')
                              .join('')
                              .slice(0, 2)
                              .toUpperCase()}
                          </div>
                        )}
                        <div>
                          <p className="text-lg font-semibold text-zinc-100">{profileView.displayName}</p>
                          <p className="text-xs text-zinc-400">{profileView.username}</p>
                          <p className="text-xs text-zinc-500">Nickname: {getDepartmentNickname(profileView.department)}</p>
                          <p className="text-xs text-zinc-500">Department: {profileView.department || 'Not set'} · Level: {profileView.level || 'Not set'}</p>
                        </div>
                      </div>
                      <button type="button" onClick={() => setProfileViewId(null)} className="rounded-full border border-zinc-700 px-3 py-1 text-xs">
                        My profile
                      </button>
                    </div>
                    <p className="mt-3 text-sm text-zinc-300">{profileView.bio}</p>
                    <div className="mt-4 flex items-center gap-4 text-xs">
                      <div>
                        <p className="text-zinc-400">Posts</p>
                        <p className="font-semibold text-zinc-100">{formatCount(profileViewPosts.length)}</p>
                      </div>
                      <div>
                        <p className="text-zinc-400">Followers</p>
                        <p className="font-semibold text-zinc-100">{formatCount(profileViewFollowers)}</p>
                      </div>
                      <div>
                        <p className="text-zinc-400">Following</p>
                        <p className="font-semibold text-zinc-100">{formatCount(profileViewFollowing)}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => (isFollowing ? unfollowUser(profileViewId) : followUser(profileViewId))}
                        disabled={previewUser}
                        className={`ml-auto rounded-full px-4 py-2 text-xs font-semibold ${
                          isFollowing ? 'border border-zinc-700 text-zinc-100' : 'bg-emerald-500 text-zinc-950'
                        }`}
                      >
                        {isFollowing ? 'Following' : 'Follow'}
                      </button>
                    </div>
                  </article>
                  <div className="grid gap-2 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                    <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Recent Posts</p>
                    {profileLoading && <p className="text-xs text-zinc-400">Loading profile...</p>}
                    {!profileLoading && profileViewPosts.length === 0 && <p className="text-xs text-zinc-400">No posts yet.</p>}
                    {profileViewPosts.slice(0, 8).map((post) => (
                      <div key={post.id} className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2">
                        <p className="text-sm text-zinc-100">{post.caption}</p>
                        <p className="mt-1 text-xs text-zinc-500">{formatRelativeTime(post.created_at)}</p>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/*  Here check listing view for other profile data */}
              {!isViewingOtherProfile && (
              <>
              <article className="overflow-hidden rounded-2xl border border-zinc-800 bg-gradient-to-br from-zinc-900 via-zinc-900 to-emerald-950/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    {profile.avatarUrl ? (
                      <button type="button" onClick={() => openAvatarModal(profile.avatarUrl)} className="rounded-full">
                        <img src={profile.avatarUrl} alt="Profile" className="h-14 w-14 rounded-full object-cover" />
                      </button>
                    ) : (
                      <div className="grid h-14 w-14 place-items-center rounded-full bg-zinc-700 text-sm font-semibold">
                        {profile.displayName
                          .split(' ')
                          .map((part) => part[0] || '')
                          .join('')
                          .slice(0, 2)
                          .toUpperCase()}
                      </div>
                    )}
                    <div>
                      <p className="text-lg font-semibold">{profile.displayName}</p>
                      <p className="text-xs text-zinc-400">{profile.username}</p>
                      <p className="text-xs text-zinc-500">Nickname: {getDepartmentNickname(profile.department)}</p>
                      <p className="text-xs text-zinc-500">Department: {profile.department || 'Not set'} · Level: {profile.level || 'Not set'}</p>
                      <p className="text-xs text-zinc-500">Status: {profile.relationshipStatus || 'single'}</p>
                    </div>
                  </div>
                  <div className="rounded-full bg-gradient-to-r from-emerald-950 via-emerald-700 to-emerald-400 px-3 py-1 text-xs font-semibold text-emerald-100 shadow-[0_0_18px_rgba(16,185,129,0.45)]">
                    Steeze Avg {mySteezeAvg}/99
                  </div>
                </div>
                <p className="mt-3 text-sm text-zinc-300">{profile.bio}</p>
                <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-2">
                    <p className="text-zinc-400">Posts</p>
                    <p className="text-sm font-semibold text-zinc-100">{formatCount(posts.filter((post) => post.user_id === currentUserId).length)}</p>
                  </div>
                  <button type="button" onClick={() => setNetworkView('followers')} className="rounded-xl border border-zinc-800 bg-zinc-950 p-2">
                    <p className="text-zinc-400">Followers</p>
                    <p className="text-sm font-semibold text-zinc-100">{formatCount(followersCount)}</p>
                  </button>
                  <button type="button" onClick={() => setNetworkView('following')} className="rounded-xl border border-zinc-800 bg-zinc-950 p-2">
                    <p className="text-zinc-400">Following</p>
                    <p className="text-sm font-semibold text-zinc-100">{formatCount(followingCount)}</p>
                  </button>
                </div>
              </article>

              <div className="grid gap-3 sm:grid-cols-3">
                <button type="button" onClick={() => setShowEditProfileModal(true)} className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-sm font-semibold text-zinc-100">
                  Edit Profile
                </button>
                <button type="button" onClick={() => setShowSettingsModal(true)} className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-sm font-semibold text-zinc-100">
                  Settings
                </button>
                <button type="button" onClick={signOut} className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-sm font-semibold text-zinc-100">
                  Logout
                </button>
              </div>

              {canUseAdminUI && (
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Admin Access</p>
                <p className="mt-2 text-sm text-zinc-300">
                  Status: <span className={isAdmin ? 'text-emerald-300' : 'text-amber-300'}>{isAdmin ? 'Admin' : 'Not Admin'}</span>
                </p>
                <p className="mt-1 break-all rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-400">UID: {currentUserId}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={copyMyUid} className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-200">
                    {copiedUid ? 'UID Copied' : 'Copy UID'}
                  </button>
                  <button type="button" onClick={() => setActiveTab('admin')} disabled={!isAdmin} className="rounded-full border border-emerald-500/40 px-3 py-1 text-xs text-emerald-200 disabled:opacity-40">
                    Open Admin Panel
                  </button>
                </div>
                {!isAdmin && <p className="mt-2 text-xs text-zinc-500">Ask an existing admin to create `admins/{currentUserId}` in Firestore.</p>}
              </div>
              )}

              <div className="grid gap-2 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Recent Posts</p>
                {posts
                  .filter((post) => post.user_id === currentUserId)
                  .slice(0, 5)
                  .map((post) => (
                    <div key={post.id} className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2">
                      <p className="text-sm text-zinc-100">{post.caption}</p>
                      <p className="mt-1 text-xs text-emerald-300">{(post.tags || []).map((tag) => `#${tag}`).join(' ')}</p>
                      <p className="mt-1 text-xs text-zinc-500">{formatRelativeTime(post.created_at)}</p>
                    </div>
                  ))}
              </div>
              </>
              )}
            </section>
          )}
        </section>

        <aside className="hidden space-y-4 lg:sticky lg:top-6 lg:block lg:h-[calc(100vh-3rem)] lg:overflow-y-auto no-scrollbar">
          {activeTab !== 'reflect' && activeTab !== 'admin' && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                <p className="text-sm font-semibold">Active Campus Topics</p>
                <div className="mt-3 space-y-2 text-xs text-zinc-300">
                  <p>#examweek</p>
                  <p>#hostellight</p>
                  <p>#departmentgist</p>
                </div>
              </div>
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                <p className="text-sm font-semibold">Quick Prompt</p>
                <p className="mt-2 text-xs text-zinc-400">What happened in your faculty today?</p>
                <button
                  type="button"
                  onClick={() => {
                    setPostMode('text')
                    setShowComposer(true)
                  }}
                  className="mt-3 rounded-full border border-zinc-700 px-3 py-1 text-xs"
                >
                  Post now
                </button>
                <button type="button" onClick={seedRandomPosts} disabled={isSeeding} className="ml-2 rounded-full border border-zinc-700 px-3 py-1 text-xs disabled:opacity-60">
                  {isSeeding ? 'Populating...' : 'Populate'}
                </button>
              </div>
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                <p className="text-sm font-semibold">Live Activity</p>
                <div className="mt-3 space-y-2 text-xs text-zinc-300">
                  {liveActivities.slice(0, 8).map((item) => (
                    <p key={item.id}>
                      {(item.actor_username || '@mirroruser')} {item.type === 'post_created' ? 'posted' : 'reacted'} ·{' '}
                      {formatRelativeTime(item.created_at)}
                    </p>
                  ))}
                  {liveActivities.length === 0 && <p className="text-zinc-500">No recent activity.</p>}
                </div>
              </div>
            </div>
          )}
          {activeTab === 'admin' && canUseAdminUI && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                <p className="text-sm font-semibold">Moderation Status</p>
                <div className="mt-3 space-y-2 text-xs text-zinc-300">
                  <p>Open reports: {adminReports.filter((report) => report.status !== 'resolved').length}</p>
                  <p>Hidden posts: {adminPosts.filter((post) => (post.moderated_status || 'active') === 'hidden').length}</p>
                  <p>Suspended users: {adminUsers.filter((entry) => entry.suspended).length}</p>
                </div>
              </div>
            </div>
          )}
          {activeTab === 'reflect' && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                <p className="text-sm font-semibold">Top Reflections Today</p>
                <div className="mt-3 space-y-2 text-xs text-zinc-300">
                  {reflectPosts.slice(0, 3).map((item) => (
                    <p key={item.id}>{resolvePostAuthor(item).label} · {getSteezeTier(item.steeze_score || 0)}</p>
                  ))}
                </div>
              </div>
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                <p className="text-sm font-semibold">Heating Up</p>
                <div className="mt-3 space-y-2 text-xs text-zinc-300">
                  {reflectPosts
                    .slice()
                    .sort((a, b) => (b.engagement_count || 0) - (a.engagement_count || 0))
                    .slice(0, 3)
                    .map((item) => (
                      <p key={`${item.id}-hot`}>{resolvePostAuthor(item).label} · 🔥</p>
                    ))}
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>
      <nav className="fixed inset-x-3 bottom-3 z-30 flex items-center justify-around rounded-2xl border border-zinc-800 bg-zinc-900/95 px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur lg:hidden">
        {mobileNavItems.map((item) => {
          const isActive = activeTab === item.id
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                if (item.id === 'post') {
                  setPostMode(activeTab === 'reflect' ? 'reflection' : 'text')
                  setShowComposer(true)
                  return
                }
                if (item.id === 'profile') setProfileViewId(null)
                setActiveTab(item.id)
              }}
              aria-label={item.label}
              className={`grid h-11 w-11 place-items-center rounded-xl ${isActive ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400'} ${item.id === 'post' ? 'border border-emerald-500/60 text-emerald-200' : ''}`}
            >
              {item.id === 'feed' && (
                <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
                  <path d="M12 3l9 7v11h-6v-6H9v6H3V10l9-7z" />
                </svg>
              )}
              {item.id === 'reflect' && <span className="text-lg leading-none">◉</span>}
              {item.id === 'rooms' && <span className="text-lg leading-none">◈</span>}
              {item.id === 'post' && <span className="text-lg leading-none">＋</span>}
              {item.id === 'search' && (
                <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
                  <path d="M10 2a8 8 0 1 1-5.29 14l-2.7 2.7a1 1 0 1 1-1.42-1.4l2.7-2.71A8 8 0 0 1 10 2zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12z" />
                </svg>
              )}
              {item.id === 'profile' && (
                <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
                  <path d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5z" />
                </svg>
              )}
              {item.id === 'admin' && <span className="text-lg leading-none">⚙</span>}
            </button>
          )
        })}
      </nav>
      {showAvatarModal && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-zinc-950/85 p-4 backdrop-blur-sm" onClick={() => setShowAvatarModal(false)}>
          <div className="w-full max-w-3xl overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-900" onClick={(event) => event.stopPropagation()}>
            <img src={avatarModalUrl} alt="Profile preview" className="max-h-[80vh] w-full object-contain" />
          </div>
        </div>
      )}
      {deleteConfirmPostId && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-zinc-950/80 p-4 backdrop-blur-sm" onClick={() => setDeleteConfirmPostId(null)}>
          <div className="w-full max-w-sm rounded-2xl border border-zinc-700 bg-zinc-900 p-4" onClick={(event) => event.stopPropagation()}>
            <p className="font-display text-lg font-semibold">Delete post?</p>
            <p className="mt-2 text-sm text-zinc-400">This action cannot be undone.</p>
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setDeleteConfirmPostId(null)} className="w-1/2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-200">
                No
              </button>
              <button type="button" onClick={() => deletePost(deleteConfirmPostId)} className="w-1/2 rounded-lg bg-rose-500 px-3 py-2 text-sm font-semibold text-zinc-950">
                Yes
              </button>
            </div>
          </div>
        </div>
      )}
      {postActionsPostId && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-zinc-950/80 p-4 backdrop-blur-sm" onClick={() => setPostActionsPostId(null)}>
          <div className="w-full max-w-sm rounded-2xl border border-zinc-700 bg-zinc-900 p-4" onClick={(event) => event.stopPropagation()}>
            <p className="font-display text-lg font-semibold">Post actions</p>
            <div className="mt-4 grid gap-2">
              <button
                type="button"
                onClick={() => {
                  reportPost(postActionsPostId)
                  setPostActionsPostId(null)
                }}
                className="w-full rounded-lg border border-zinc-700 px-3 py-2 text-left text-sm text-zinc-200"
              >
                Flag post
              </button>
              {(() => {
                const targetPost = posts.find((post) => post.id === postActionsPostId)
                if (!canDeletePost(targetPost)) return null
                return (
                  <button
                    type="button"
                    onClick={() => {
                      setPostActionsPostId(null)
                      setDeleteConfirmPostId(postActionsPostId)
                    }}
                    className="w-full rounded-lg border border-rose-500/30 px-3 py-2 text-left text-sm text-rose-300"
                  >
                    Delete post
                  </button>
                )
              })()}
              <button type="button" onClick={() => setPostActionsPostId(null)} className="w-full rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {networkView && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-zinc-950/80 p-4 backdrop-blur-sm" onClick={() => setNetworkView(null)}>
          <div className="w-full max-w-md max-h-[86vh] overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-900 p-4" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between">
              <p className="font-display text-lg font-semibold">{networkView === 'followers' ? 'Followers' : 'Following'}</p>
              <button type="button" onClick={() => setNetworkView(null)} className="rounded-full border border-zinc-700 px-3 py-1 text-xs">
                Close
              </button>
            </div>
            <div className="mt-3 max-h-80 space-y-2 overflow-y-auto">
              {(networkView === 'followers' ? followersList : followingList).length === 0 && (
                <p className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-500">No users yet.</p>
              )}
              {(networkView === 'followers' ? followersList : followingList).map((userItem) => (
                <button key={userItem.id} type="button" onClick={() => openUserProfile(userItem.id)} className="w-full rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-left">
                  <p className="text-sm font-semibold text-zinc-100">{userItem.displayName}</p>
                  <p className="text-xs text-zinc-400">{userItem.username}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {reflectionCommentsPostId && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-zinc-950/80 p-4 backdrop-blur-sm" onClick={() => setReflectionCommentsPostId(null)}>
          <div className="w-full max-w-xl max-h-[86vh] overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-900 p-4" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between">
              <p className="font-display text-lg font-semibold">Comments</p>
              <button type="button" onClick={() => setReflectionCommentsPostId(null)} className="rounded-full border border-zinc-700 px-3 py-1 text-xs">
                Close
              </button>
            </div>
            <div className="mt-3 max-h-72 space-y-2 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950 p-3">
              {(() => {
                const post = posts.find((entry) => entry.id === reflectionCommentsPostId)
                const comments = [...(post?.comments || [])].sort((a, b) => toMillis(b.created_at) - toMillis(a.created_at))
                if (comments.length === 0) return <p className="text-xs text-zinc-500">No comments yet.</p>
                return comments.map((comment) => (
                  <div key={comment.id || `${reflectionCommentsPostId}-${comment.user_id}-${comment.created_at}`} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2">
                    <button type="button" onClick={() => comment.user_id && openUserProfile(comment.user_id)} className="text-xs font-semibold text-zinc-200">
                      {comment.author_name || 'Mirror Student'}
                    </button>
                    <p className="text-[11px] text-zinc-500">{comment.author_handle || ''}</p>
                    <p className="mt-1 text-xs text-zinc-300">{comment.text}</p>
                  </div>
                ))
              })()}
            </div>
            <div className="mt-3 flex gap-2">
              <input
                value={reflectionCommentDrafts[reflectionCommentsPostId] || ''}
                onChange={(event) => setReflectionCommentDrafts((prev) => ({ ...prev, [reflectionCommentsPostId]: event.target.value }))}
                placeholder="Comment on this reflection..."
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm"
              />
              <button type="button" onClick={() => addReflectionComment(reflectionCommentsPostId)} className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-zinc-950">
                Send
              </button>
            </div>
          </div>
        </div>
      )}
      {showOnboarding && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-zinc-950/80 p-4 backdrop-blur-sm" onClick={() => setShowOnboarding(false)}>
          <form onSubmit={saveOnboarding} onClick={(event) => event.stopPropagation()} className="w-full max-w-md max-h-[86vh] space-y-3 overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-900 p-4">
            <h2 className="font-display text-lg font-semibold">Complete Your Profile</h2>
            <input
              value={onboardingDraft.displayName}
              onChange={(event) => setOnboardingDraft((prev) => ({ ...prev, displayName: event.target.value }))}
              placeholder="Your name"
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
            />
            <input
              value={onboardingDraft.campusId}
              onChange={(event) => setOnboardingDraft((prev) => ({ ...prev, campusId: event.target.value }))}
              placeholder="Campus"
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
            />
            <select
              value={onboardingDraft.department}
              onChange={(event) => setOnboardingDraft((prev) => ({ ...prev, department: event.target.value }))}
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
            >
              {departmentsByFaculty.map((group) => (
                <optgroup key={group.faculty} label={group.faculty}>
                  {group.items.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <select
              value={onboardingDraft.level}
              onChange={(event) => setOnboardingDraft((prev) => ({ ...prev, level: event.target.value }))}
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
            >
              <option value="100">100</option>
              <option value="200">200</option>
              <option value="300">300</option>
              <option value="400">400</option>
              <option value="500">500</option>
              <option value="PG">PG</option>
            </select>
            <select
              value={onboardingDraft.relationshipStatus}
              onChange={(event) => setOnboardingDraft((prev) => ({ ...prev, relationshipStatus: event.target.value }))}
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
            >
              <option value="single">single</option>
              <option value="stolen">stolen</option>
            </select>
            <button type="submit" className="w-full rounded-xl bg-emerald-500 px-3 py-2 text-sm font-semibold text-zinc-950">
              Save profile
            </button>
          </form>
        </div>
      )}
      {showEditProfileModal && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-zinc-950/80 p-4 backdrop-blur-sm" onClick={() => setShowEditProfileModal(false)}>
          <form
            onSubmit={(event) => {
              saveProfile(event)
              setShowEditProfileModal(false)
            }}
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-xl max-h-[86vh] space-y-3 overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-900 p-4"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold">Edit Profile</h2>
              <button type="button" onClick={() => setShowEditProfileModal(false)} className="rounded-full border border-zinc-700 px-3 py-1 text-xs">
                Close
              </button>
            </div>
            <input
              value={editProfileDraft.displayName}
              onChange={(event) => setEditProfileDraft((prev) => ({ ...prev, displayName: event.target.value }))}
              placeholder={profile.displayName || 'Display name'}
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
            />
            <input
              value={editProfileDraft.username}
              onChange={(event) => setEditProfileDraft((prev) => ({ ...prev, username: event.target.value }))}
              placeholder={profile.username || 'Username'}
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
            />
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
              <p className="text-xs text-zinc-400">{avatarUploading ? 'Uploading photo...' : 'Profile photo'}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <label className="inline-flex cursor-pointer items-center rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-200">
                  {profile.avatarUrl ? 'Change photo' : 'Upload photo'}
                  <input type="file" accept="image/*" onChange={uploadProfileAvatar} className="hidden" />
                </label>
                {profile.avatarUrl && (
                  <button type="button" onClick={removeProfileAvatar} className="rounded-lg border border-rose-500/40 px-3 py-2 text-xs text-rose-300">
                    Remove photo
                  </button>
                )}
              </div>
            </div>
            <select
              value={editProfileDraft.department || profile.department || 'Computer Science'}
              onChange={(event) => setEditProfileDraft((prev) => ({ ...prev, department: event.target.value }))}
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
            >
              {departmentsByFaculty.map((group) => (
                <optgroup key={group.faculty} label={group.faculty}>
                  {group.items.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <select
              value={editProfileDraft.level || profile.level || '100'}
              onChange={(event) => setEditProfileDraft((prev) => ({ ...prev, level: event.target.value }))}
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
            >
              <option value="100">100</option>
              <option value="200">200</option>
              <option value="300">300</option>
              <option value="400">400</option>
              <option value="500">500</option>
              <option value="PG">PG</option>
            </select>
            <select
              value={editProfileDraft.relationshipStatus || profile.relationshipStatus || 'single'}
              onChange={(event) => setEditProfileDraft((prev) => ({ ...prev, relationshipStatus: event.target.value }))}
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
            >
              <option value="single">single</option>
              <option value="stolen">stolen</option>
            </select>
            <textarea
              value={editProfileDraft.bio}
              onChange={(event) => setEditProfileDraft((prev) => ({ ...prev, bio: event.target.value }))}
              placeholder={profile.bio || 'Bio'}
              rows={4}
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
            />
            <button type="submit" className="w-full rounded-xl bg-emerald-500 px-3 py-2 text-sm font-medium text-zinc-950">
              Save profile
            </button>
          </form>
        </div>
      )}
      {showSettingsModal && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-zinc-950/80 p-4 backdrop-blur-sm" onClick={() => setShowSettingsModal(false)}>
          <div onClick={(event) => event.stopPropagation()} className="w-full max-w-xl max-h-[86vh] space-y-3 overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-900 p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold">Settings</h2>
              <button type="button" onClick={() => setShowSettingsModal(false)} className="rounded-full border border-zinc-700 px-3 py-1 text-xs">
                Close
              </button>
            </div>
            <label className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">
              <span>Private account</span>
              <input
                type="checkbox"
                checked={settings.privateAccount}
                onChange={(event) => setSettings((prev) => ({ ...prev, privateAccount: event.target.checked }))}
              />
            </label>
            <label className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">
              <span>Show campus on profile</span>
              <input
                type="checkbox"
                checked={settings.showCampus}
                onChange={(event) => setSettings((prev) => ({ ...prev, showCampus: event.target.checked }))}
              />
            </label>
            <label className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">
              <span>Email alerts</span>
              <input
                type="checkbox"
                checked={settings.emailAlerts}
                onChange={(event) => setSettings((prev) => ({ ...prev, emailAlerts: event.target.checked }))}
              />
            </label>
            <button
              type="button"
              onClick={() => {
                saveSettings()
                setShowSettingsModal(false)
              }}
              className="w-full rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm font-semibold text-emerald-100"
            >
              Save settings
            </button>
          </div>
        </div>
      )}
      {showComposer && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-zinc-950/80 p-4 backdrop-blur-sm" onClick={() => setShowComposer(false)}>
          <form onSubmit={createPost} onClick={(event) => event.stopPropagation()} className="w-full max-w-xl max-h-[88vh] space-y-4 overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-900 p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold">Create New Post</h2>
              <button type="button" onClick={() => setShowComposer(false)} className="rounded-full border border-zinc-700 px-3 py-1 text-xs">
                Close
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setPostMode('text')}
                className={`rounded-xl border px-3 py-2 text-sm ${postMode === 'text' ? 'border-emerald-500/70 bg-emerald-500/10 text-emerald-100' : 'border-zinc-700 text-zinc-300'}`}
              >
                Text Post
              </button>
              <button
                type="button"
                onClick={() => setPostMode('reflection')}
                className={`rounded-xl border px-3 py-2 text-sm ${postMode === 'reflection' ? 'border-emerald-500/70 bg-emerald-500/10 text-emerald-100' : 'border-zinc-700 text-zinc-300'}`}
              >
                Reflection
              </button>
            </div>

            <textarea
              value={draftPost.caption}
              onChange={(event) => setDraftPost((prev) => ({ ...prev, caption: event.target.value }))}
              placeholder="Type anything..."
              rows={5}
              className="w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm"
            />

            <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-zinc-400">{selectedFile ? selectedFile.name : postMode === 'reflection' ? 'Add image (required)' : 'Add image (optional)'}</p>
                <div className="flex items-center gap-2">
                  {selectedFile && (
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedFile(null)
                        setPreviewUrl('')
                      }}
                      className="rounded-full border border-zinc-700 px-3 py-1 text-[11px] text-zinc-300"
                    >
                      Remove
                    </button>
                  )}
                  <label className="grid h-10 w-10 cursor-pointer place-items-center rounded-full border border-emerald-500/50 bg-emerald-500/10 text-emerald-200">
                    <span className="text-xl leading-none">+</span>
                    <input type="file" accept="image/*" onChange={handleMediaPick} className="hidden" />
                  </label>
                </div>
              </div>

              {previewUrl && (
                <div className="relative mt-3 h-40 w-full overflow-hidden rounded-xl border border-zinc-800">
                  <img src={previewUrl} alt="Preview" className="h-full w-full object-cover" />
                </div>
              )}
            </div>

            {uploading && (
              <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-xs">
                <p className="text-zinc-300">{uploadStatus || 'Uploading...'}</p>
                <div className="h-2 w-full rounded-full bg-zinc-800">
                  <div className="h-full rounded-full bg-emerald-500" style={{ width: `${uploadProgress}%` }} />
                </div>
                <p className="text-zinc-400">{uploadProgress}%</p>
              </div>
            )}

            <button
              type="submit"
              disabled={!canPublish}
              className="w-full rounded-xl bg-emerald-500 px-3 py-2 text-sm font-medium text-zinc-950 disabled:cursor-not-allowed disabled:bg-zinc-700"
            >
              Publish post
            </button>
          </form>
        </div>
      )}

      {showCreateRoom && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-zinc-950/80 p-4 backdrop-blur-sm" onClick={() => setShowCreateRoom(false)}>
          <form
            onSubmit={createRoom}
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-md space-y-3 rounded-2xl border border-zinc-700 bg-zinc-900 p-4"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold">Create Anonymous Room</h2>
              <button type="button" onClick={() => setShowCreateRoom(false)} className="rounded-full border border-zinc-700 px-3 py-1 text-xs">
                Close
              </button>
            </div>
            <input
              value={roomDraft.name}
              onChange={(event) => setRoomDraft((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="Room name"
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
              maxLength={60}
              required
            />
            <textarea
              value={roomDraft.description}
              onChange={(event) => setRoomDraft((prev) => ({ ...prev, description: event.target.value }))}
              placeholder="Short description (optional)"
              rows={3}
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
              maxLength={240}
            />
            <select
              value={roomDraft.postTtl}
              onChange={(event) => setRoomDraft((prev) => ({ ...prev, postTtl: Number(event.target.value) }))}
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
            >
              {roomTtlOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  Posts delete after {option.label}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={isCreatingRoom}
              className={`w-full rounded-xl bg-emerald-500 px-3 py-2 text-sm font-semibold text-zinc-950 ${isCreatingRoom ? 'opacity-60' : ''}`}
            >
              {isCreatingRoom ? 'Creating...' : 'Create room'}
            </button>
          </form>
        </div>
      )}

    </main>
  )
}

export default App
