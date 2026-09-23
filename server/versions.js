// 计费规则版本：每次价格或参数变化生成一个新版本，记版本号、生效时刻、改动项与改动前后的值
const { badRequest, notFound } = require('./errors');
const { zonePriceSnapshotOf, BASELINE_VERSION_NO } = require('./store');
const pricing = require('./pricing');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// 页面上填的时刻形如 2026-09-23 10:00，没有时区信息时按东八区解释
function parseFlexibleTime(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  let normalized = text;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(text)) normalized = text.replace(' ', 'T') + ':00+08:00';
  else if (/^\d{4}-\d{2}-\d{2}$/.test(text)) normalized = text + 'T00:00:00+08:00';
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function latestVersion(data) {
  return pricing.latestVersion(data);
}

// 用 data.settings + data.zones 的当前价目生成下一版快照；与上一版没有差异就不允许发版
// 调用前要先把改动写进 data（不改盘），发版后由调用方统一 save
function publishVersion(data, options) {
  const opts = options || {};
  const previous = latestVersion(data);
  const snapshot = {
    settings: pricing.settingsOf(data),
    zones: zonePriceSnapshotOf(data.zones),
  };
  const changes = previous ? pricing.diffSnapshots(previous.snapshot, snapshot) : [];
  if (previous && changes.length === 0) {
    throw badRequest('PRICING_NO_CHANGE', '价格与参数都没有变化，不需要生成新版本');
  }

  let effectiveAtIso;
  if (opts.effectiveAt) {
    const date = parseFlexibleTime(opts.effectiveAt);
    if (!date) throw badRequest('PRICING_EFFECTIVE_AT_INVALID', '生效时刻要形如 2026-09-23 10:00', { field: 'effectiveAt' });
    effectiveAtIso = date.toISOString();
    if (previous && date.toISOString() <= previous.effectiveAt) {
      throw badRequest('PRICING_EFFECTIVE_AT_ORDER', '新版本的生效时刻必须晚于上一版（v' + previous.versionNo + '：' + previous.effectiveAt + '）', { field: 'effectiveAt' });
    }
  } else {
    effectiveAtIso = new Date().toISOString();
    if (previous && effectiveAtIso <= previous.effectiveAt) {
      // 与上一版同一时刻（例如脚本连改两次）：顺延 1 秒，保证版本链按时刻严格递增
      effectiveAtIso = new Date(new Date(previous.effectiveAt).getTime() + 1000).toISOString();
    }
  }

  const version = {
    versionNo: previous ? previous.versionNo + 1 : BASELINE_VERSION_NO,
    effectiveAt: effectiveAtIso,
    reason: String(opts.reason || '').trim() || (opts.source === 'settings' ? '修改全局计费参数' : opts.source === 'zone' ? '调整分区价格' : '调整计费规则'),
    source: opts.source || 'manual',
    createdAt: new Date().toISOString(),
    snapshot,
    changes,
  };
  data.pricingVersions.push(version);
  // 工作副本 settings 始终与最新版本快照保持一致
  data.settings = clone(snapshot.settings);
  return version;
}

function changeSummary(changes) {
  const kinds = {};
  (changes || []).forEach((change) => { kinds[change.kind] = (kinds[change.kind] || 0) + 1; });
  return {
    settingCount: kinds.setting || 0,
    zoneCount: kinds.zone || 0,
    zoneAddedCount: kinds['zone-added'] || 0,
    zoneRemovedCount: kinds['zone-removed'] || 0,
  };
}

function listVersions(data) {
  const list = pricing.versionsOf(data).slice().sort((a, b) => b.versionNo - a.versionNo);
  return {
    versions: list.map((version, index) => {
      const prev = list[index + 1] || null;
      return {
        versionNo: version.versionNo,
        effectiveAt: version.effectiveAt,
        reason: version.reason,
        source: version.source || 'manual',
        createdAt: version.createdAt,
        changeCount: (version.changes || []).length,
        changes: version.changes || [],
        summary: changeSummary(version.changes),
        isBaseline: version.versionNo === BASELINE_VERSION_NO && !(version.changes || []).length,
        previousVersionNo: prev ? prev.versionNo : null,
      };
    }),
    total: list.length,
    latestVersionNo: list.length ? list[0].versionNo : null,
  };
}

function getVersionDetail(data, versionNo) {
  const version = pricing.findVersion(data, versionNo);
  if (!version) throw notFound('PRICING_VERSION_NOT_FOUND', '没有这个计费规则版本');
  const list = pricing.versionsOf(data);
  const index = list.findIndex((item) => item.versionNo === version.versionNo);
  const prev = list[index - 1] || null;
  const next = list[index + 1] || null;
  return {
    versionNo: version.versionNo,
    effectiveAt: version.effectiveAt,
    reason: version.reason,
    source: version.source || 'manual',
    createdAt: version.createdAt,
    snapshot: clone(version.snapshot),
    changes: version.changes || [],
    summary: changeSummary(version.changes),
    previousVersionNo: prev ? prev.versionNo : null,
    nextVersionNo: next ? next.versionNo : null,
    isLatest: index === list.length - 1,
  };
}

function resolveVersionNo(data, ref) {
  const text = String(ref == null ? '' : ref).trim();
  if (text === '' || text === 'latest') {
    const latest = latestVersion(data);
    if (!latest) throw badRequest('PRICING_NO_VERSION', '还没有任何计费规则版本');
    return latest.versionNo;
  }
  const no = Number(text);
  if (!Number.isInteger(no) || !pricing.findVersion(data, no)) {
    throw badRequest('PRICING_VERSION_NOT_FOUND', '版本号不存在：' + text, { field: 'version' });
  }
  return no;
}

// 两版差异：返回带方向的差异项与汇总
function compareVersions(data, aRef, bRef) {
  const aNo = resolveVersionNo(data, aRef);
  const bNo = resolveVersionNo(data, bRef);
  const versionA = pricing.findVersion(data, aNo);
  const versionB = pricing.findVersion(data, bNo);
  const diffs = pricing.diffSnapshots(versionA.snapshot, versionB.snapshot);
  return {
    versionA: { versionNo: versionA.versionNo, effectiveAt: versionA.effectiveAt, reason: versionA.reason },
    versionB: { versionNo: versionB.versionNo, effectiveAt: versionB.effectiveAt, reason: versionB.reason },
    diffs,
    total: diffs.length,
    summary: changeSummary(diffs),
    identical: diffs.length === 0,
  };
}

module.exports = {
  parseFlexibleTime,
  publishVersion,
  listVersions,
  getVersionDetail,
  resolveVersionNo,
  compareVersions,
  changeSummary,
};
