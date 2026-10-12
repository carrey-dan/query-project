import crypto from 'node:crypto'
import axios from 'axios'

const CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=utf-8'

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest()
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex')
}

function isChinaRegion(region) {
  return region.startsWith('cn-')
}

export function serviceHost(service, region) {
  const suffix = isChinaRegion(region) ? 'amazonaws.com.cn' : 'amazonaws.com'
  return `${service}.${region}.${suffix}`
}

function encodeBody(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key] ?? '')}`)
    .join('&')
}

export async function signedPost({
  accessKeyId,
  secretAccessKey,
  sessionToken,
  region,
  service,
  hostService,
  params,
}) {
  const host = serviceHost(hostService, region)
  const endpoint = `http://${host}/`
  const body = encodeBody(params)
  const payloadHash = sha256Hex(body)

  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const datestamp = amzDate.slice(0, 8)

  const headerMap = {
    'content-type': CONTENT_TYPE,
    host,
    'x-amz-date': amzDate,
  }
  if (sessionToken) {
    headerMap['x-amz-security-token'] = sessionToken
  }

  const signedHeaders = Object.keys(headerMap).sort().join(';')
  const canonicalHeaders = Object.keys(headerMap)
    .sort()
    .map((name) => `${name}:${headerMap[name]}\n`)
    .join('')

  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const algorithm = 'AWS4-HMAC-SHA256'
  const credentialScope = `${datestamp}/${region}/${service}/aws4_request`
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  const kDate = hmac(`AWS4${secretAccessKey}`, datestamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = hmac(kSigning, stringToSign).toString('hex')

  const authorization = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const headers = {
    'Content-Type': CONTENT_TYPE,
    'X-Amz-Date': amzDate,
    Authorization: authorization,
    Host: host,
  }
  if (sessionToken) {
    headers['X-Amz-Security-Token'] = sessionToken
  }

  const response = await axios.post(endpoint, body, {
    headers,
    transformRequest: [(data) => data],
    responseType: 'text',
    validateStatus: () => true,
    timeout: 20000,
  })

  return {
    status: response.status,
    data: response.data,
  }
}

export function ec2Call(creds, params) {
  return signedPost({
    ...creds,
    service: 'ec2',
    hostService: 'ec2',
    params: { Version: '2016-11-15', ...params },
  })
}

export function cloudWatchCall(creds, params) {
  return signedPost({
    ...creds,
    service: 'monitoring',
    hostService: 'monitoring',
    params: { Version: '2010-08-01', ...params },
  })
}

export async function signedJsonPost({
  accessKeyId,
  secretAccessKey,
  sessionToken,
  region,
  service,
  hostService,
  target,
  payload,
}) {
  const contentType = 'application/x-amz-json-1.1'
  const host = serviceHost(hostService, region)
  const endpoint = `http://${host}/`
  const body = JSON.stringify(payload)
  const payloadHash = sha256Hex(body)

  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const datestamp = amzDate.slice(0, 8)

  const headerMap = {
    'content-type': contentType,
    host,
    'x-amz-date': amzDate,
    'x-amz-target': target,
  }
  if (sessionToken) {
    headerMap['x-amz-security-token'] = sessionToken
  }

  const signedHeaders = Object.keys(headerMap).sort().join(';')
  const canonicalHeaders = Object.keys(headerMap)
    .sort()
    .map((name) => `${name}:${headerMap[name]}\n`)
    .join('')

  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const algorithm = 'AWS4-HMAC-SHA256'
  const credentialScope = `${datestamp}/${region}/${service}/aws4_request`
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  const kDate = hmac(`AWS4${secretAccessKey}`, datestamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = hmac(kSigning, stringToSign).toString('hex')
  const authorization = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const headers = {
    'Content-Type': contentType,
    'X-Amz-Date': amzDate,
    'X-Amz-Target': target,
    Authorization: authorization,
    Host: host,
  }
  if (sessionToken) {
    headers['X-Amz-Security-Token'] = sessionToken
  }

  const response = await axios.post(endpoint, body, {
    headers,
    transformRequest: [(data) => data],
    responseType: 'text',
    validateStatus: () => true,
    timeout: 20000,
  })

  return {
    status: response.status,
    data: response.data,
  }
}

export function ssmCall(creds, target, payload) {
  return signedJsonPost({
    ...creds,
    service: 'ssm',
    hostService: 'ssm',
    target,
    payload,
  })
}
