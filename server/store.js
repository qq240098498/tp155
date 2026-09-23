const fs = require('fs');
const path = require('path');
const { AppError } = require('./errors');

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'db.json');

const DEFAULT_SETTINGS = {
  volumetricDivisor: 6000,
  minChargeYuan: 8,
  oversizeWeightKg: 30,
  oversizePieces: 3,
  oversizeFeeYuan: 20,
  insurancePermille: 20,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyData() {
  return {
    meta: { name: '运单计费与账单核对台', currency: 'CNY', updatedAt: null },
    settings: clone(DEFAULT_SETTINGS),
    zones: [],
    customers: [],
    waybills: [],
    bills: [],
    pricingVersions: [],
  };
}

function normalize(raw) {
  const base = emptyData();
  const data = raw && typeof raw === 'object' ? raw : {};
  const out = {
    meta: Object.assign({}, base.meta, data.meta || {}),
    settings: Object.assign({}, base.settings, data.settings || {}),
    zones: Array.isArray(data.zones) ? data.zones.filter((item) => item && item.id) : [],
    customers: Array.isArray(data.customers) ? data.customers.filter((item) => item && item.id) : [],
    waybills: Array.isArray(data.waybills) ? data.waybills.filter((item) => item && item.id) : [],
    bills: Array.isArray(data.bills) ? data.bills.filter((item) => item && item.id) : [],
    pricingVersions: Array.isArray(data.pricingVersions) ? data.pricingVersions.filter((item) => item && item.version) : [],
  };
  out.zones.forEach((zone) => {
    if (!Array.isArray(zone.cities)) zone.cities = [];
    if (!zone.aliases || typeof zone.aliases !== 'object') zone.aliases = {};
  });
  out.waybills.forEach((waybill) => {
    if (!Array.isArray(waybill.services)) waybill.services = [];
  });
  out.bills.forEach((bill) => {
    if (!Array.isArray(bill.waybillIds)) bill.waybillIds = [];
    if (!Array.isArray(bill.lines)) bill.lines = [];
  });
  out.pricingVersions.forEach((version) => {
    if (!version.snapshot || typeof version.snapshot !== 'object') version.snapshot = {};
    if (!Array.isArray(version.snapshot.zones)) version.snapshot.zones = [];
    if (!version.snapshot.settings || typeof version.snapshot.settings !== 'object') version.snapshot.settings = {};
    if (!Array.isArray(version.changes)) version.changes = [];
  });
  // 旧数据没有版本历史：把现有的全局参数与分区价格固化成 V1 基线，
  // 这样升级前产生的运单与账单都能追溯到“当时那一版”。
  if (out.pricingVersions.length === 0) {
    out.pricingVersions.push({
      version: 1,
      note: '系统初始化基线（升级前的全局价格）',
      source: '系统',
      createdAt: '2026-01-01T00:00:00.000Z',
      changes: [],
      snapshot: {
        settings: clone(out.settings),
        zones: out.zones.map((zone) => ({
          id: zone.id,
          code: zone.code,
          name: zone.name,
          firstWeightKg: Number(zone.firstWeightKg) || 0,
          firstPriceYuan: Number(zone.firstPriceYuan) || 0,
          addUnitKg: Number(zone.addUnitKg) || 0,
          addPriceYuan: Number(zone.addPriceYuan) || 0,
          remoteFeeYuan: Number(zone.remoteFeeYuan) || 0,
        })),
      },
    });
  }
  return out;
}

function ensureDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(dataFile)) {
    const seeded = normalize(null);
    save(seeded);
    return seeded;
  }
  const text = fs.readFileSync(dataFile, 'utf8');
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AppError(500, 'DATA_UNREADABLE', '数据文件读不出来，请检查 data/db.json 的内容是否完整');
  }
  return normalize(parsed);
}

function save(data) {
  ensureDir();
  const next = normalize(data);
  next.meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(dataFile, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function nextId(prefix, list) {
  let max = 0;
  list.forEach((item) => {
    const match = String(item.id || '').match(/(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  });
  return prefix + '-' + String(max + 1).padStart(4, '0');
}

module.exports = { load, save, normalize, nextId, dataFile, DEFAULT_SETTINGS };
