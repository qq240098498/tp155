// 计费规则版本
// 每次改动全局参数或分区价格都会固化一版快照：版本号、生效时刻、改动项与改动前后的值。
// 任一时刻“在用的是哪一版” = 生效时刻不晚于该时刻的最新一版。
const { badRequest, notFound } = require('./errors');
const { load, save } = require('./store');

const SETTING_FIELDS = ['volumetricDivisor', 'minChargeYuan', 'oversizeWeightKg', 'oversizePieces', 'oversizeFeeYuan', 'insurancePermille'];
const ZONE_PRICE_FIELDS = ['firstWeightKg', 'firstPriceYuan', 'addUnitKg', 'addPriceYuan', 'remoteFeeYuan'];

const FIELD_LABELS = {
  volumetricDivisor: '体积系数',
  minChargeYuan: '最低收费（元）',
  oversizeWeightKg: '超规重量线（kg）',
  oversizePieces: '超规件数线（件）',
  oversizeFeeYuan: '超规附加（元）',
  insurancePermille: '保价费率（千分比）',
  firstWeightKg: '首重（kg）',
  firstPriceYuan: '首重价（元）',
  addUnitKg: '续重单位（kg）',
  addPriceYuan: '续重价（元）',
  remoteFeeYuan: '偏远附加（元）',
};

// 进入计费的分区字段只保留价格口径；城市归属不属于价格，不进版本快照
function zonePriceOf(zone) {
  return {
    id: zone.id,
    code: zone.code,
    name: zone.name,
    firstWeightKg: Number(zone.firstWeightKg) || 0,
    firstPriceYuan: Number(zone.firstPriceYuan) || 0,
    addUnitKg: Number(zone.addUnitKg) || 0,
    addPriceYuan: Number(zone.addPriceYuan) || 0,
    remoteFeeYuan: Number(zone.remoteFeeYuan) || 0,
  };
}

// 当前生效规则的完整快照
function snapshotOf(data) {
  return {
    settings: SETTING_FIELDS.reduce((acc, key) => {
      acc[key] = Number(data.settings[key]);
      return acc;
    }, {}),
    zones: data.zones.map(zonePriceOf),
  };
}

function num(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 对比两份快照，逐项列出差异（方向：before 版 → after 版）
function diffSnapshots(before, after) {
  const changes = [];
  const beforeSettings = (before && before.settings) || {};
  const afterSettings = (after && after.settings) || {};
  SETTING_FIELDS.forEach((field) => {
    const oldValue = num(beforeSettings[field]);
    const newValue = num(afterSettings[field]);
    if (oldValue !== newValue) {
      changes.push({
        scope: '全局参数', path: 'settings.' + field, field,
        fieldLabel: FIELD_LABELS[field] || field,
        refId: '', refName: '全局参数',
        before: oldValue, after: newValue,
      });
    }
  });

  const beforeZones = new Map(((before && before.zones) || []).map((zone) => [zone.id, zone]));
  const afterZones = new Map(((after && after.zones) || []).map((zone) => [zone.id, zone]));
  afterZones.forEach((zone, id) => {
    const old = beforeZones.get(id);
    ZONE_PRICE_FIELDS.forEach((field) => {
      const oldValue = old ? num(old[field]) : null;
      const newValue = num(zone[field]);
      if (oldValue !== newValue) {
        changes.push({
          scope: '分区价格', path: 'zone.' + id + '.' + field, field,
          fieldLabel: FIELD_LABELS[field] || field,
          refId: id, refName: zone.code + ' ' + zone.name,
          added: !old, removed: false,
          before: oldValue, after: newValue,
        });
      }
    });
    if (old) beforeZones.delete(id);
  });
  // 被删掉的分区：每个价格字段都记一条“删除”
  beforeZones.forEach((zone) => {
    ZONE_PRICE_FIELDS.forEach((field) => {
      changes.push({
        scope: '分区价格', path: 'zone.' + zone.id + '.' + field, field,
        fieldLabel: FIELD_LABELS[field] || field,
        refId: zone.id, refName: zone.code + ' ' + zone.name,
        added: false, removed: true,
        before: num(zone[field]), after: null,
      });
    });
  });
  return changes;
}

function sortVersions(versions) {
  return versions.slice().sort((a, b) => Number(a.version) - Number(b.version));
}

// 某一时刻在用的版本：生效时刻 <= time 的最新一版
function effectiveVersionAt(data, timeISO) {
  const time = new Date(String(timeISO || '')).getTime();
  if (!Number.isFinite(time)) throw badRequest('VERSION_TIME_INVALID', '时刻要能解析，例如 2026-09-01 10:30');
  const versions = sortVersions(data.pricingVersions || []);
  let hit = null;
  versions.forEach((version) => {
    const t = new Date(version.createdAt).getTime();
    if (Number.isFinite(t) && t <= time) hit = version;
  });
  return hit;
}

// 生成新版本并落盘；调用方先把 data 的 settings/zones 改成目标状态，再传入改动说明
function createVersion(data, options) {
  const versions = sortVersions(data.pricingVersions || []);
  const previous = versions[versions.length - 1] || null;
  const versionNo = previous ? Number(previous.version) + 1 : 1;
  const snapshot = snapshotOf(data);
  let changes = Array.isArray(options && options.changes) ? options.changes : [];
  if (!changes.length && previous) changes = diffSnapshots(previous.snapshot, snapshot);
  const record = {
    version: versionNo,
    note: String((options && options.note) || '').trim() || ('第 ' + versionNo + ' 版规则'),
    source: String((options && options.source) || '').trim() || '手工改动',
    createdAt: new Date().toISOString(),
    changes: changes,
    snapshot,
  };
  data.pricingVersions.push(record);
  return record;
}

// 保存并返回落盘后的新版本（带展示字段）
function persistNewVersion(data, options) {
  const record = createVersion(data, options);
  save(data);
  const saved = load().pricingVersions.find((item) => item.version === record.version) || record;
  return decorateVersion(saved, load());
}

function decorateChange(change) {
  return Object.assign({}, change, {
    beforeText: change.before === null || change.before === undefined ? '（无）' : String(change.before),
    afterText: change.after === null || change.after === undefined ? '（无）' : String(change.after),
    changeText: (change.before === null || change.before === undefined ? '（无）' : change.before) +
      ' → ' + (change.after === null || change.after === undefined ? '（无）' : change.after),
  });
}

function decorateVersion(version, data) {
  const versions = sortVersions((data && data.pricingVersions) || []);
  const index = versions.findIndex((item) => item.version === version.version);
  const next = index >= 0 ? versions[index + 1] : null;
  return {
    version: version.version,
    note: version.note,
    source: version.source,
    createdAt: version.createdAt,
    createdAtText: String(version.createdAt || '').replace('T', ' ').slice(0, 19),
    changeCount: (version.changes || []).length,
    changes: (version.changes || []).map(decorateChange),
    replacedAt: next ? next.createdAt : null,
    replacedAtText: next ? String(next.createdAt).replace('T', ' ').slice(0, 19) : '',
    current: index === versions.length - 1,
  };
}

function listVersions() {
  const data = load();
  const versions = sortVersions(data.pricingVersions || []).slice().reverse();
  return {
    versions: versions.map((version) => decorateVersion(version, data)),
    total: versions.length,
    currentVersion: versions.length ? versions[0].version : null,
  };
}

function getVersionRecord(data, versionNo) {
  const n = Number(versionNo);
  if (!Number.isInteger(n) || n < 1) throw badRequest('VERSION_NO_INVALID', '版本号要从 1 开始的整数');
  return (data.pricingVersions || []).find((item) => Number(item.version) === n) || null;
}

function getVersion(versionNo) {
  const data = load();
  const version = getVersionRecord(data, versionNo);
  if (!version) throw notFound('VERSION_NOT_FOUND', '没有第 ' + Number(versionNo) + ' 版规则');
  return decorateVersion(version, data);
}

function findEffectiveVersion(query) {
  const data = load();
  const time = String((query && query.time) || '').trim();
  if (!time) throw badRequest('VERSION_TIME_REQUIRED', '要给一个时刻，例如 2026-09-01 10:30');
  const version = effectiveVersionAt(data, time);
  if (!version) throw notFound('VERSION_EFFECTIVE_NONE', '这个时刻还没有任何生效的规则版本');
  return {
    time,
    version: decorateVersion(version, data),
  };
}

// 任选两版列差异项（方向：a 版 → b 版）
function compareVersions(aNo, bNo) {
  const data = load();
  const a = getVersionRecord(data, aNo);
  const b = getVersionRecord(data, bNo);
  if (!a) throw notFound('VERSION_NOT_FOUND', '没有第 ' + Number(aNo) + ' 版规则');
  if (!b) throw notFound('VERSION_NOT_FOUND', '没有第 ' + Number(bNo) + ' 版规则');
  const changes = diffSnapshots(a.snapshot, b.snapshot).map(decorateChange);
  return {
    base: decorateVersion(a, data),
    target: decorateVersion(b, data),
    changes,
    changeCount: changes.length,
  };
}

module.exports = {
  SETTING_FIELDS,
  ZONE_PRICE_FIELDS,
  FIELD_LABELS,
  zonePriceOf,
  snapshotOf,
  diffSnapshots,
  effectiveVersionAt,
  createVersion,
  persistNewVersion,
  decorateVersion,
  listVersions,
  getVersion,
  getVersionRecord,
  findEffectiveVersion,
  compareVersions,
  sortVersions,
};
