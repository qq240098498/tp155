const express = require('express');
const { AppError } = require('./errors');
const store = require('./store');
const zones = require('./zones');
const customers = require('./customers');
const waybills = require('./waybills');
const bills = require('./bills');
const pricing = require('./pricing');
const ruleVersions = require('./ruleVersions');
const trials = require('./trials');

function buildSummary() {
  const data = store.load();
  const settings = pricing.settingsOf(data);
  const decorated = data.waybills.map((waybill) => waybills.decorate(waybill, data));
  const unzoned = decorated.filter((item) => !item.zoneKnown);
  const cached = data.waybills.filter((waybill) => Number(waybill.quoteCacheYuan) > 0);
  const issued = data.bills.filter((bill) => bill.status === '已出账');
  const voided = data.bills.filter((bill) => bill.status === '已作废');
  const issuedAmount = issued.reduce((sum, bill) => sum + Number(bill.amountYuan || 0), 0);
  return {
    zoneCount: data.zones.length,
    customerCount: data.customers.length,
    waybillCount: data.waybills.length,
    billCount: data.bills.length,
    issuedCount: issued.length,
    voidedCount: voided.length,
    issuedAmountYuan: pricing.roundFen(issuedAmount),
    lockedCount: decorated.filter((item) => item.locked).length,
    unzonedCount: unzoned.length,
    unzonedCities: Array.from(new Set(unzoned.map((item) => item.toCity))),
    cachedCount: cached.length,
    statusCounts: ['待发', '在途', '已签收', '退回'].map((status) => ({
      status,
      count: decorated.filter((item) => item.status === status).length,
    })),
    periods: Array.from(new Set(data.waybills.map((waybill) => bills.periodOf(waybill)).filter(Boolean))).sort(),
    settings,
    currentVersion: (function () {
      const list = ruleVersions.sortVersions(data.pricingVersions || []);
      const latest = list[list.length - 1];
      return latest ? { version: latest.version, note: latest.note, createdAt: latest.createdAt, count: list.length } : null;
    })(),
    updatedAt: data.meta.updatedAt,
  };
}

function createRouter() {
  const router = express.Router();

  router.get('/health', (req, res) => {
    res.json({ ok: true, service: '运单计费与账单核对台' });
  });

  router.get('/summary', (req, res) => {
    res.json(buildSummary());
  });

  router.get('/settings', (req, res) => {
    const data = store.load();
    res.json({ settings: pricing.settingsOf(data) });
  });

  // 改全局参数：参数真正发生变化才生成新版本，写清改了哪些项、前后值
  router.patch('/settings', (req, res) => {
    const data = store.load();
    const payload = req.body || {};
    const incoming = [];
    ruleVersions.SETTING_FIELDS.forEach((key) => {
      if (!(key in payload)) return;
      const value = Number(payload[key]);
      if (!Number.isFinite(value) || value < 0) {
        throw new AppError(400, 'SETTINGS_VALUE_INVALID', '设置项 ' + key + ' 必须是不小于 0 的数字', { field: key });
      }
      incoming.push({ key, value });
    });
    const changed = incoming.filter((item) => Number(data.settings[item.key]) !== item.value);
    if (changed.length > 0) {
      changed.forEach((item) => { data.settings[item.key] = item.value; });
      const note = String(payload.note || '').trim() || ('调整全局计费参数：' + changed.map((item) => ruleVersions.FIELD_LABELS[item.key]).join('、'));
      ruleVersions.createVersion(data, { note, source: '全局参数' });
    }
    store.save(data);
    const fresh = store.load();
    const latest = ruleVersions.sortVersions(fresh.pricingVersions || []).slice(-1)[0] || null;
    res.json({
      settings: pricing.settingsOf(fresh),
      versionCreated: changed.length > 0 ? latest.version : null,
      changed: changed.length,
    });
  });

  // 规则版本：列表 / 详情 / 任意时刻生效版本 / 两版差异
  router.get('/pricing/versions', (req, res) => res.json(ruleVersions.listVersions()));
  router.get('/pricing/effective', (req, res) => res.json(ruleVersions.findEffectiveVersion(req.query || {})));
  router.get('/pricing/versions/:version', (req, res) => res.json({ version: ruleVersions.getVersion(req.params.version) }));
  router.get('/pricing/diff', (req, res) => {
    const q = req.query || {};
    res.json(ruleVersions.compareVersions(q.base, q.target));
  });

  // 版本化试算：单运单两版并排；同一批运单按两版分别试算给合计差额
  router.get('/pricing/trial-waybill/:id', (req, res) => {
    const q = req.query || {};
    res.json(trials.trialWaybill(req.params.id, { baseVersion: q.baseVersion, targetVersion: q.targetVersion }));
  });
  router.post('/pricing/compare', (req, res) => res.json(trials.trialBatch(req.body || {})));

  router.get('/zones', (req, res) => res.json(zones.listZones()));
  router.post('/zones', (req, res) => res.status(201).json(zones.createZone(req.body || {})));
  router.patch('/zones/:id', (req, res) => res.json(zones.updateZone(req.params.id, req.body || {})));
  router.delete('/zones/:id', (req, res) => res.json(zones.removeZone(req.params.id)));

  router.get('/customers', (req, res) => res.json(customers.listCustomers()));
  router.post('/customers', (req, res) => res.status(201).json(customers.createCustomer(req.body || {})));
  router.patch('/customers/:id', (req, res) => res.json(customers.updateCustomer(req.params.id, req.body || {})));
  router.delete('/customers/:id', (req, res) => res.json(customers.removeCustomer(req.params.id)));

  router.get('/waybills', (req, res) => res.json(waybills.listWaybills(req.query || {})));
  router.post('/waybills', (req, res) => res.status(201).json(waybills.createWaybill(req.body || {})));
  router.patch('/waybills/:id', (req, res) => res.json(waybills.updateWaybill(req.params.id, req.body || {})));
  router.delete('/waybills/:id', (req, res) => res.json(waybills.removeWaybill(req.params.id)));
  router.post('/waybills/:id/quote', (req, res) => res.json(waybills.quote(req.params.id)));

  router.get('/bills', (req, res) => res.json(bills.listBills(req.query || {})));
  router.get('/periods', (req, res) => res.json(bills.listPeriods()));
  router.post('/bills/generate', (req, res) => res.status(201).json(bills.generateBill(req.body || {})));
  router.get('/bills/:id', (req, res) => res.json(bills.getBill(req.params.id)));
  router.post('/bills/:id/void', (req, res) => res.json(bills.voidBill(req.params.id)));

  router.use((req, res) => {
    res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: '没有这个接口：' + req.method + ' ' + req.path } });
  });

  return router;
}

function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: String(err && err.message ? err.message : err) } });
}

module.exports = { createRouter, errorHandler, buildSummary };
