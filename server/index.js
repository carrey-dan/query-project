import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'
import { XMLParser } from 'fast-xml-parser'
import { fetchBtNetwork, mapBtOverview, requireBtConfig } from './bt.js'

const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))

const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: true,
  trimValues: true,
})

function asArray(value) {
  if (value == null || value === '') return []
  return Array.isArray(value) ? value : [value]
}

function awsError(xml) {
  if (xml == null || xml === '') return null
  const text = String(xml).trim()
  if (text.startsWith('{')) {
    try {
      const json = JSON.parse(text)
      const message = json.Message || json.message || json.__type
      if (message) {
        return { code: json.__type || json.Code || 'AwsError', message }
      }
    } catch {
      return null
    }
  }
  const doc = xmlParser.parse(text)
  const error =
    doc?.Response?.Errors?.Error ||
    doc?.ErrorResponse?.Error ||
    doc?.Error ||
    doc?.DescribeInstancesResponse?.Errors?.Error
  if (!error) return null
  if (typeof error === 'string') {
    return { code: 'AwsError', message: error }
  }
  return {
    code: error.Code || error.__type || 'AwsError',
    message: error.Message || error.message || text.slice(0, 400),
  }
}

async function awsXml(fn, actionLabel) {
  const { status, data } = await fn()
  const error = awsError(data)
  if (status >= 400 || error) {
    const detail = error?.message || String(data || '').slice(0, 400) || `AWS HTTP ${status}`
    const err = new Error(actionLabel ? `${actionLabel}: ${detail}` : detail)
    err.status = status >= 400 ? status : 400
    err.code = error?.code
    throw err
  }
  return xmlParser.parse(data)
}

async function awsJson(fn, actionLabel) {
  const { status, data } = await fn()
  const error = awsError(data)
  if (status >= 400 || error) {
    const detail = error?.message || String(data || '').slice(0, 400) || `AWS HTTP ${status}`
    const err = new Error(actionLabel ? `${actionLabel}: ${detail}` : detail)
    err.status = status >= 400 ? status : 400
    err.code = error?.code
    throw err
  }
  return data ? JSON.parse(data) : {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function requireCreds(body = {}) {
  const accessKeyId = String(body.accessKeyId || process.env.AWS_ACCESS_KEY_ID || '').trim()
  const secretAccessKey = String(body.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || '').trim()
  const sessionToken = String(body.sessionToken || process.env.AWS_SESSION_TOKEN || '').trim()
  const region = String(body.region || process.env.AWS_REGION || 'ap-southeast-1').trim()
  const instanceId = String(body.instanceId || process.env.AWS_INSTANCE_ID || '').trim()
  const trafficQuotaGb = Number(body.trafficQuotaGb || process.env.TRAFFIC_QUOTA_GB || 0)

  const missing = []
  if (!accessKeyId) missing.push('accessKeyId')
  if (!secretAccessKey) missing.push('secretAccessKey')
  if (!region) missing.push('region')
  if (!instanceId) missing.push('instanceId')
  if (missing.length) {
    const error = new Error(`请先填写：${missing.join(', ')}`)
    error.status = 400
    throw error
  }

  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: sessionToken || undefined,
    region,
    instanceId,
    trafficQuotaGb: Number.isFinite(trafficQuotaGb) ? trafficQuotaGb : 0,
  }
}

function isoNoMs(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function pickLatest(datapoints, field = 'Average') {
  const points = asArray(datapoints)
    .filter((item) => item?.Timestamp)
    .sort((a, b) => new Date(a.Timestamp) - new Date(b.Timestamp))
  const last = points[points.length - 1]
  return last ? Number(last[field] ?? last.Sum ?? last.Maximum ?? 0) : null
}

function seriesFrom(datapoints, field) {
  return asArray(datapoints)
    .filter((item) => item?.Timestamp)
    .sort((a, b) => new Date(a.Timestamp) - new Date(b.Timestamp))
    .map((item) => ({
      time: item.Timestamp,
      value: Number(item[field] ?? item.Sum ?? item.Average ?? 0),
    }))
}

async function getMetricStatistics(creds, options) {
  const params = {
    Action: 'GetMetricStatistics',
    Namespace: options.namespace,
    MetricName: options.metricName,
    StartTime: isoNoMs(options.start),
    EndTime: isoNoMs(options.end),
    Period: String(options.period),
  }
  asArray(options.statistics).forEach((stat, index) => {
    params[`Statistics.member.${index + 1}`] = stat
  })
  if (options.unit) params.Unit = options.unit
  asArray(options.dimensions).forEach((dim, index) => {
    params[`Dimensions.member.${index + 1}.Name`] = dim.Name
    params[`Dimensions.member.${index + 1}.Value`] = dim.Value
  })

  const doc = await awsXml(() => cloudWatchCall(creds, params), options.metricName)
  return asArray(doc?.GetMetricStatisticsResponse?.GetMetricStatisticsResult?.Datapoints?.member)
}

async function listMetrics(creds, extraParams) {
  const metrics = []
  let nextToken
  for (let page = 0; page < 5; page += 1) {
    const params = { Action: 'ListMetrics', ...extraParams }
    if (nextToken) params.NextToken = nextToken
    const doc = await awsXml(() => cloudWatchCall(creds, params), 'ListMetrics')
    const result = doc?.ListMetricsResponse?.ListMetricsResult
    metrics.push(...asArray(result?.Metrics?.member))
    nextToken = result?.NextToken
    if (!nextToken) break
  }
  return metrics
}

function metricHasInstance(metric, instanceId) {
  return dimensionsFromMetric(metric).some(
    (dim) => dim.Name === 'InstanceId' && String(dim.Value) === instanceId,
  )
}

async function listGuestMetrics(creds, instanceId) {
  const [byId, allAgent, linux] = await Promise.all([
    listMetrics(creds, {
      Namespace: 'CWAgent',
      'Dimensions.member.1.Name': 'InstanceId',
      'Dimensions.member.1.Value': instanceId,
    }).catch(() => []),
    listMetrics(creds, { Namespace: 'CWAgent' }).catch(() => []),
    listMetrics(creds, {
      Namespace: 'System/Linux',
      'Dimensions.member.1.Name': 'InstanceId',
      'Dimensions.member.1.Value': instanceId,
    }).catch(() => []),
  ])
  const filteredAgent = allAgent.filter((metric) => metricHasInstance(metric, instanceId))
  const merged = [...byId, ...filteredAgent]
  const seen = new Set()
  const unique = []
  for (const metric of merged) {
    const key = `${metric.Namespace}|${metric.MetricName}|${JSON.stringify(dimensionsFromMetric(metric))}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(metric)
  }
  return { agent: unique, linux }
}

async function probeNamedMetric(creds, namespace, metricName, statistic, start, end, instanceId) {
  try {
    const points = await getMetricStatistics(creds, {
      namespace,
      metricName,
      start,
      end,
      period: 300,
      statistics: [statistic],
      dimensions: [{ Name: 'InstanceId', Value: instanceId }],
    })
    return pickLatest(points, statistic)
  } catch {
    return null
  }
}

async function fetchGuestFromSsm(creds) {
  const info = await awsJson(
    () =>
      ssmCall(creds, 'AmazonSSM.DescribeInstanceInformation', {
        Filters: [{ Key: 'InstanceIds', Values: [creds.instanceId] }],
      }),
    'DescribeInstanceInformation',
  )
  const instance = asArray(info.InstanceInformationList)[0]
  if (!instance || instance.PingStatus !== 'Online') {
    return { ok: false, reason: 'not-managed' }
  }

  const sent = await awsJson(
    () =>
      ssmCall(creds, 'AmazonSSM.SendCommand', {
        InstanceIds: [creds.instanceId],
        DocumentName: 'AWS-RunShellScript',
        TimeoutSeconds: 30,
        Parameters: {
          commands: [
            "awk '/MemTotal:/{t=$2} /MemAvailable:/{a=$2} END{print \"MEM\", t*1024, (t-a)*1024}' /proc/meminfo",
            "df -B1 -P / | awk 'NR==2{print \"DISK\",$2,$3}'",
            "awk '{print \"LOAD\",$1}' /proc/loadavg",
          ],
        },
      }),
    'SendCommand',
  )
  const commandId = sent.Command?.CommandId
  if (!commandId) return { ok: false, reason: 'no-command' }

  let output = ''
  for (let i = 0; i < 12; i += 1) {
    await sleep(700)
    const invocation = await awsJson(
      () =>
        ssmCall(creds, 'AmazonSSM.GetCommandInvocation', {
          CommandId: commandId,
          InstanceId: creds.instanceId,
        }),
      'GetCommandInvocation',
    )
    const status = invocation.Status
    if (status === 'Success') {
      output = `${invocation.StandardOutputContent || ''}`
      break
    }
    if (['Failed', 'Cancelled', 'TimedOut', 'Undeliverable', 'Terminated'].includes(status)) {
      return { ok: false, reason: invocation.StatusDetails || status }
    }
  }
  if (!output) return { ok: false, reason: 'timeout' }

  const mem = output.match(/MEM\s+(\d+)\s+(\d+)/)
  const disk = output.match(/DISK\s+(\d+)\s+(\d+)/)
  const load = output.match(/LOAD\s+([\d.]+)/)
  return {
    ok: true,
    memTotalMb: mem ? Number(mem[1]) / 1024 ** 2 : null,
    memUsedMb: mem ? Number(mem[2]) / 1024 ** 2 : null,
    diskTotalGb: disk ? Number(disk[1]) / 1024 ** 3 : null,
    diskUsedGb: disk ? Number(disk[2]) / 1024 ** 3 : null,
    load1m: load ? Number(load[1]) : null,
  }
}

function dimensionsFromMetric(metric) {
  return asArray(metric?.Dimensions?.member).map((item) => ({
    Name: item.Name,
    Value: String(item.Value),
  }))
}

function findAgentMetric(metrics, name, extra = {}) {
  return metrics.find((metric) => {
    if (metric.MetricName !== name) return false
    const dims = dimensionsFromMetric(metric)
    if (extra.path) {
      return dims.some((dim) => dim.Name === 'path' && dim.Value === extra.path)
    }
    return true
  })
}

async function fetchAgentValue(creds, metric, statistic, start, end, period = 300) {
  if (!metric) return null
  const points = await getMetricStatistics(creds, {
    namespace: 'CWAgent',
    metricName: metric.MetricName,
    start,
    end,
    period,
    statistics: [statistic],
    dimensions: dimensionsFromMetric(metric),
  })
  return pickLatest(points, statistic)
}

function tagName(tags) {
  const item = asArray(tags).find((tag) => tag.key === 'Name' || tag.Key === 'Name')
  return item?.value || item?.Value || ''
}

function loadStatus(percent) {
  if (percent == null) return '暂无数据'
  if (percent < 40) return '运行流畅'
  if (percent < 70) return '负载正常'
  if (percent < 90) return '负载偏高'
  return '负载过高'
}

async function queryOverview(creds) {
  const now = new Date()
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000)
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const instanceDim = [{ Name: 'InstanceId', Value: creds.instanceId }]

  const describeDoc = await awsXml(() =>
    ec2Call(creds, {
      Action: 'DescribeInstances',
      'InstanceId.1': creds.instanceId,
    }),
  )

  const reservation = asArray(describeDoc?.DescribeInstancesResponse?.reservationSet?.item)[0]
  const instance = asArray(reservation?.instancesSet?.item)[0]
  if (!instance) {
    const err = new Error('未找到该实例。请检查 Instance ID 与 Region 是否匹配。')
    err.status = 404
    throw err
  }

  const instanceType = instance.instanceType
  const volumeIds = asArray(instance.blockDeviceMapping?.item)
    .map((item) => item?.ebs?.volumeId)
    .filter(Boolean)

  const [typeDoc, volumeDoc, cpuPoints, netInPoints, netOutPoints, diskReadPoints, diskWritePoints, guestMetrics] =
    await Promise.all([
      awsXml(
        () =>
          ec2Call(creds, {
            Action: 'DescribeInstanceTypes',
            'InstanceType.1': instanceType,
          }),
        'DescribeInstanceTypes',
      ).catch(() => null),
      volumeIds.length
        ? awsXml(() => {
            const params = { Action: 'DescribeVolumes' }
            volumeIds.forEach((id, index) => {
              params[`VolumeId.${index + 1}`] = id
            })
            return ec2Call(creds, params)
          }, 'DescribeVolumes').catch(() => null)
        : Promise.resolve(null),
      getMetricStatistics(creds, {
        namespace: 'AWS/EC2',
        metricName: 'CPUUtilization',
        start: hourAgo,
        end: now,
        period: 300,
        statistics: ['Average'],
        unit: 'Percent',
        dimensions: instanceDim,
      }).catch(() => []),
      getMetricStatistics(creds, {
        namespace: 'AWS/EC2',
        metricName: 'NetworkOut',
        start: hourAgo,
        end: now,
        period: 300,
        statistics: ['Sum'],
        dimensions: instanceDim,
      }).catch(() => []),
      getMetricStatistics(creds, {
        namespace: 'AWS/EC2',
        metricName: 'NetworkIn',
        start: hourAgo,
        end: now,
        period: 300,
        statistics: ['Sum'],
        dimensions: instanceDim,
      }).catch(() => []),
      getMetricStatistics(creds, {
        namespace: 'AWS/EC2',
        metricName: 'DiskWriteBytes',
        start: hourAgo,
        end: now,
        period: 300,
        statistics: ['Sum'],
        dimensions: instanceDim,
      }).catch(() => []),
      getMetricStatistics(creds, {
        namespace: 'AWS/EC2',
        metricName: 'DiskReadBytes',
        start: hourAgo,
        end: now,
        period: 300,
        statistics: ['Sum'],
        dimensions: instanceDim,
      }).catch(() => []),
      listGuestMetrics(creds, creds.instanceId),
    ])

  const typeInfo = asArray(typeDoc?.DescribeInstanceTypesResponse?.instanceTypeSet?.item)[0]
  const vcpus = Number(typeInfo?.vCpuInfo?.defaultVCpus || 0)
  const memoryTotalFromType = Number(typeInfo?.memoryInfo?.sizeInMiB || 0)

  const volumes = asArray(volumeDoc?.DescribeVolumesResponse?.volumeSet?.item)
  const diskTotalFromVolumes = volumes.reduce((sum, vol) => sum + Number(vol.size || 0), 0)
  const rootVolume =
    volumes.find((vol) =>
      asArray(vol.attachmentSet?.item).some((att) => att.device === '/dev/xvda' || att.device === '/dev/sda1'),
    ) || volumes[0]

  const cpuPercent = pickLatest(cpuPoints, 'Average')
  const netOutBytes = pickLatest(netOutPoints, 'Sum')
  const netInBytes = pickLatest(netInPoints, 'Sum')
  const diskWriteBytes = pickLatest(diskWritePoints, 'Sum')
  const diskReadBytes = pickLatest(diskReadPoints, 'Sum')

  const agentMetrics = guestMetrics.agent
  const memUsedMetric = findAgentMetric(agentMetrics, 'mem_used')
  const memUsedPercentMetric = findAgentMetric(agentMetrics, 'mem_used_percent')
  const diskUsedMetric = findAgentMetric(agentMetrics, 'disk_used', { path: '/' }) || findAgentMetric(agentMetrics, 'disk_used')
  const diskUsedPercentMetric =
    findAgentMetric(agentMetrics, 'disk_used_percent', { path: '/' }) || findAgentMetric(agentMetrics, 'disk_used_percent')
  const loadMetric = findAgentMetric(agentMetrics, 'cpu_load_1m') || findAgentMetric(agentMetrics, 'load1')

  const [memUsedRaw, memUsedPercent, diskUsedRaw, diskUsedPercent, load1m, linuxMemPercent, linuxDiskPercent, monthOut, monthIn] =
    await Promise.all([
      fetchAgentValue(creds, memUsedMetric, 'Average', hourAgo, now),
      fetchAgentValue(creds, memUsedPercentMetric, 'Average', hourAgo, now),
      fetchAgentValue(creds, diskUsedMetric, 'Average', hourAgo, now),
      fetchAgentValue(creds, diskUsedPercentMetric, 'Average', hourAgo, now),
      fetchAgentValue(creds, loadMetric, 'Average', hourAgo, now),
      probeNamedMetric(creds, 'System/Linux', 'MemoryUtilization', 'Average', hourAgo, now, creds.instanceId),
      probeNamedMetric(creds, 'System/Linux', 'DiskSpaceUtilization', 'Average', hourAgo, now, creds.instanceId),
      getMetricStatistics(creds, {
        namespace: 'AWS/EC2',
        metricName: 'NetworkOut',
        start: monthStart,
        end: now,
        period: 86400,
        statistics: ['Sum'],
        dimensions: instanceDim,
      }).catch(() => []),
      getMetricStatistics(creds, {
        namespace: 'AWS/EC2',
        metricName: 'NetworkIn',
        start: monthStart,
        end: now,
        period: 86400,
        statistics: ['Sum'],
        dimensions: instanceDim,
      }).catch(() => []),
    ])

  const monthSent = asArray(monthOut).reduce((sum, item) => sum + Number(item.Sum || 0), 0)
  const monthReceived = asArray(monthIn).reduce((sum, item) => sum + Number(item.Sum || 0), 0)
  const monthTotal = monthSent + monthReceived

  const nics = asArray(instance.networkInterfaceSet?.item).map((nic) => ({
    id: nic.networkInterfaceId,
    name: nic.description || nic.networkInterfaceId,
    privateIp: nic.privateIpAddress,
  }))

  let memUsedMb = memUsedRaw != null ? Number(memUsedRaw) / 1024 ** 2 : null
  let memUsedPct = memUsedPercent
  let diskUsedGb = diskUsedRaw != null ? Number(diskUsedRaw) / 1024 ** 3 : null
  let diskUsedPct = diskUsedPercent
  let loadValue = load1m
  let guestSource = agentMetrics.length > 0 ? 'cwagent' : null
  let notice = null

  if (memUsedPct == null && linuxMemPercent != null) {
    memUsedPct = linuxMemPercent
    guestSource = guestSource || 'linux'
  }
  if (diskUsedPct == null && linuxDiskPercent != null) {
    diskUsedPct = linuxDiskPercent
    guestSource = guestSource || 'linux'
  }

  let memoryTotalMb = memoryTotalFromType
  let diskTotalGb = diskTotalFromVolumes

  if (memUsedPct == null && memUsedMb == null) {
    const ssm = await fetchGuestFromSsm(creds).catch((error) => ({ ok: false, reason: error.message }))
    if (ssm.ok) {
      guestSource = 'ssm'
      memUsedMb = ssm.memUsedMb
      diskUsedGb = ssm.diskUsedGb ?? diskUsedGb
      loadValue = ssm.load1m ?? loadValue
      if (!memoryTotalMb && ssm.memTotalMb) memoryTotalMb = ssm.memTotalMb
      if (!diskTotalGb && ssm.diskTotalGb) diskTotalGb = ssm.diskTotalGb
    } else if (!guestSource) {
      notice =
        'AWS/EC2 官方指标不含内存和磁盘用量。已尝试 CloudWatch Agent 和 SSM，当前都没有用量数据。请在实例上安装 CloudWatch Agent，或让实例加入 Systems Manager（实例角色 AmazonSSMManagedInstanceCore），并给查询用户加上 ssm:DescribeInstanceInformation、ssm:SendCommand、ssm:GetCommandInvocation。'
    }
  }

  const loadPercent =
    loadValue != null && vcpus
      ? Math.min(100, (Number(loadValue) / vcpus) * 100)
      : cpuPercent

  const memoryPercent =
    memUsedPct != null
      ? memUsedPct
      : memUsedMb != null && memoryTotalMb
        ? (memUsedMb / memoryTotalMb) * 100
        : null

  const diskPercent =
    diskUsedPct != null
      ? diskUsedPct
      : diskUsedGb != null && diskTotalGb
        ? (diskUsedGb / diskTotalGb) * 100
        : null

  if (memUsedMb == null && memoryPercent != null && memoryTotalMb) {
    memUsedMb = (memoryPercent / 100) * memoryTotalMb
  }
  if (diskUsedGb == null && diskPercent != null && diskTotalGb) {
    diskUsedGb = (diskPercent / 100) * diskTotalGb
  }

  return {
    instance: {
      id: instance.instanceId,
      name: tagName(instance.tagSet?.item) || instance.instanceId,
      type: instanceType,
      state: instance.instanceState?.name,
      az: instance.placement?.availabilityZone,
      publicIp: instance.ipAddress || '',
      privateIp: instance.privateIpAddress || '',
      vpcId: instance.vpcId || '',
      launchTime: instance.launchTime,
      vcpus,
      memoryTotalMb,
      diskTotalGb,
      rootDevice: rootVolume ? asArray(rootVolume.attachmentSet?.item)[0]?.device || '/' : '/',
      nics,
      agentInstalled: Boolean(guestSource),
      guestSource,
    },
    notice,
    cards: {
      load: {
        percent: loadPercent,
        label: loadStatus(loadPercent),
      },
      cpu: {
        percent: cpuPercent,
        cores: vcpus,
      },
      memory: {
        percent: memoryPercent,
        usedMb: memUsedMb,
        totalMb: memoryTotalMb,
      },
      disk: {
        percent: diskPercent,
        usedGb: diskUsedGb,
        totalGb: diskTotalGb,
        mount: '/',
      },
      network: {
        upBytesPerPeriod: netOutBytes,
        downBytesPerPeriod: netInBytes,
        periodSeconds: 300,
      },
      traffic: {
        sentBytes: monthSent,
        receivedBytes: monthReceived,
        totalBytes: monthTotal,
        quotaBytes: creds.trafficQuotaGb > 0 ? creds.trafficQuotaGb * 1024 ** 3 : 0,
      },
    },
    io: {
      writeBytesPerPeriod: diskWriteBytes,
      readBytesPerPeriod: diskReadBytes,
      periodSeconds: 300,
    },
  }
}

async function querySeries(creds, kind) {
  const now = new Date()
  const start = new Date(now.getTime() - 60 * 60 * 1000)
  const instanceDim = [{ Name: 'InstanceId', Value: creds.instanceId }]
  const isTraffic = kind !== 'disk'

  const [upPoints, downPoints] = await Promise.all([
    getMetricStatistics(creds, {
      namespace: 'AWS/EC2',
      metricName: isTraffic ? 'NetworkOut' : 'DiskWriteBytes',
      start,
      end: now,
      period: 300,
      statistics: ['Sum'],
      dimensions: instanceDim,
    }),
    getMetricStatistics(creds, {
      namespace: 'AWS/EC2',
      metricName: isTraffic ? 'NetworkIn' : 'DiskReadBytes',
      start,
      end: now,
      period: 300,
      statistics: ['Sum'],
      dimensions: instanceDim,
    }),
  ])

  const up = seriesFrom(upPoints, 'Sum').map((point) => ({
    ...point,
    value: point.value / 300,
  }))
  const down = seriesFrom(downPoints, 'Sum').map((point) => ({
    ...point,
    value: point.value / 300,
  }))

  const upTotal = asArray(upPoints).reduce((sum, item) => sum + Number(item.Sum || 0), 0)
  const downTotal = asArray(downPoints).reduce((sum, item) => sum + Number(item.Sum || 0), 0)
  const upCurrent = up[up.length - 1]?.value ?? 0
  const downCurrent = down[down.length - 1]?.value ?? 0

  return {
    kind: isTraffic ? 'traffic' : 'disk',
    currentUp: upCurrent,
    currentDown: downCurrent,
    totalUp: upTotal,
    totalDown: downTotal,
    series: { up, down },
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/overview', async (req, res) => {
  try {
    const creds = requireCreds(req.body)
    const data = await queryOverview(creds)
    res.json({ ok: true, data })
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      code: error.code,
      message: error.message || '查询失败',
    })
  }
})

app.post('/api/series', async (req, res) => {
  try {
    const creds = requireCreds(req.body)
    const data = await querySeries(creds, req.body.kind)
    res.json({ ok: true, data })
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      code: error.code,
      message: error.message || '查询失败',
    })
  }
})

async function handleBtOverview(req, res) {
  try {
    const config = requireBtConfig(req.body)
    const raw = await fetchBtNetwork(config)
    const data = mapBtOverview(raw, config)
    res.json({ ok: true, data })
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      code: error.code,
      message: error.message || '宝塔查询失败',
    })
  }
}

app.post('/api/bt/overview', handleBtOverview)
app.post('/api/bt/overview.php', handleBtOverview)

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir))
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next()
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    res.sendFile(path.join(distDir, 'index.html'), (err) => {
      if (err) next(err)
    })
  })
}

const port = Number(process.env.PORT || 8787)
app.listen(port, () => {
  console.log(`AWS query proxy listening on http://127.0.0.1:${port}`)
  if (fs.existsSync(distDir)) {
    console.log(`UI: http://127.0.0.1:${port}`)
  }
})
