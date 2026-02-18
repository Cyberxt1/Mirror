const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME
const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID
const configuredSignEndpoint = import.meta.env.VITE_CLOUDINARY_SIGN_ENDPOINT || ''
const configuredSignEndpoints = String(import.meta.env.VITE_CLOUDINARY_SIGN_ENDPOINTS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
const useFunctionsEmulator = String(import.meta.env.VITE_USE_FUNCTIONS_EMULATOR || '').toLowerCase() === 'true'
const uploadMode = String(import.meta.env.VITE_CLOUDINARY_UPLOAD_MODE || 'signed').toLowerCase()
const fallbackSignEndpoints = projectId
  ? [
      `https://us-central1-${projectId}.cloudfunctions.net/signCloudinary`,
      `https://us-central1-${projectId}.cloudfunctions.net/getUploadSignature`,
    ]
  : []
const localEmulatorEndpoints =
  import.meta.env.DEV && projectId && useFunctionsEmulator
    ? [
        `http://127.0.0.1:5001/${projectId}/us-central1/signCloudinary`,
        `http://127.0.0.1:5001/${projectId}/us-central1/getUploadSignature`,
      ]
    : []
const signEndpoints = Array.from(
  new Set([...configuredSignEndpoints, configuredSignEndpoint, ...fallbackSignEndpoints, ...localEmulatorEndpoints].filter(Boolean)),
)
const unsignedUploadPreset = import.meta.env.VITE_CLOUDINARY_UNSIGNED_PRESET || ''
const maxImageBytes = 10 * 1024 * 1024
const maxVideoBytes = 60 * 1024 * 1024

function getResourceType(file) {
  if (file?.type?.startsWith('video/')) return 'video'
  return 'image'
}

function validateFile(file) {
  if (!file) throw new Error('No file selected.')
  const isVideo = file.type.startsWith('video/')
  const isImage = file.type.startsWith('image/')
  if (!isVideo && !isImage) throw new Error('Only images and videos are allowed.')
  const maxBytes = isVideo ? maxVideoBytes : maxImageBytes
  if (file.size > maxBytes) {
    const mb = Math.round(maxBytes / (1024 * 1024))
    throw new Error(`File is too large. Max ${mb}MB.`)
  }
}

function uploadWithProgress(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.upload.onprogress = (event) => {
      if (!onProgress || !event.lengthComputable) return
      const percent = Math.round((event.loaded / event.total) * 100)
      onProgress(percent)
    }
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText || '{}')
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data)
        } else {
          reject(new Error(data.error?.message || 'Upload failed'))
        }
      } catch (error) {
        reject(error)
      }
    }
    xhr.onerror = () => reject(new Error('Upload failed'))
    xhr.send(formData)
  })
}

async function postJsonWithTimeout(url, payload, headers = {}, timeoutMs = 12000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function uploadToCloudinaryUnsigned(file, resourceType, options = {}) {
  if (!cloudName || !unsignedUploadPreset) return null
  const formData = new FormData()
  formData.append('file', file)
  formData.append('upload_preset', unsignedUploadPreset)
  if (options.folder) formData.append('folder', options.folder)
  const uploadUrl = `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`
  const data = await uploadWithProgress(uploadUrl, formData, options.onProgress)
  return {
    secureUrl: data.secure_url,
    publicId: data.public_id || '',
    resourceType,
    cloudName,
  }
}

export async function uploadToCloudinarySigned(file, options = {}) {
  if (!cloudName) {
    throw new Error('Cloudinary env vars are missing.')
  }

  validateFile(file)

  const resourceType = options.resourceType || getResourceType(file)
  if (uploadMode === 'unsigned') {
    if (!unsignedUploadPreset) {
      throw new Error('Unsigned upload mode is enabled but VITE_CLOUDINARY_UNSIGNED_PRESET is missing.')
    }
    return uploadToCloudinaryUnsigned(file, resourceType, options)
  }

  let signatureResponse = null
  let lastNetworkError = null
  let triedEndpoints = []

  for (const endpoint of signEndpoints) {
    triedEndpoints = [...triedEndpoints, endpoint]
    try {
      const response = await postJsonWithTimeout(
        endpoint,
        {
          folder: options.folder || 'mirror',
          resource_type: resourceType,
          fileName: file.name,
          fileSize: file.size,
        },
        {
          ...(options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}),
          ...(options.appCheckToken ? { 'X-Firebase-AppCheck': options.appCheckToken } : {}),
        },
      )
      signatureResponse = response
      if (response.ok) break
    } catch (error) {
      lastNetworkError = error
      continue
    }
  }

  if (!signatureResponse && unsignedUploadPreset) {
    return uploadToCloudinaryUnsigned(file, resourceType, options)
  }

  if (!signatureResponse) {
    const reason = lastNetworkError?.name === 'AbortError' ? 'request timed out' : lastNetworkError?.message || 'network failure'
    throw new Error(`Failed to reach upload signature endpoint (${reason}). Tried: ${triedEndpoints.join(', ')}`)
  }

  if (!signatureResponse.ok) {
    const errorText = await signatureResponse.text()
    if (unsignedUploadPreset) {
      return uploadToCloudinaryUnsigned(file, resourceType, options)
    }
    throw new Error(errorText || `Failed to sign upload at ${signatureResponse.url || 'endpoint'}.`)
  }

  const { signature, timestamp, apiKey, folder, cloudName: signedCloud, publicId } = await signatureResponse.json()
  const uploadCloud = signedCloud || cloudName
  const formData = new FormData()

  formData.append('file', file)
  formData.append('api_key', apiKey)
  formData.append('timestamp', timestamp)
  formData.append('signature', signature)
  if (folder) formData.append('folder', folder)
  if (publicId) formData.append('public_id', publicId)

  const uploadUrl = `https://api.cloudinary.com/v1_1/${uploadCloud}/${resourceType}/upload`
  const data = await uploadWithProgress(uploadUrl, formData, options.onProgress)

  return {
    secureUrl: data.secure_url,
    publicId: data.public_id || publicId,
    resourceType,
    cloudName: uploadCloud,
  }
}
