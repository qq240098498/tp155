const express = require('express');
const { AppError } = require('./errors');
const store = require('./store');
const zones = require('./zones');
const customers = require('./customers');
const waybills = require('./waybills');
const bills = require('./bills');
const pricing = require('./pricing');
const versions = require('./versions');

function buildSummary() {
  const data = store.load();
  const settings = pricing.settingsOf(data);
  const latest = pricing.latestVersion(data);
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
    pricingVersionCount: pricing.versionsOf(data).length,
    currentVersionNo: latest ? latest.versionNo : null,
    currentVersionEffectiveAt: latest ? latest.effectiveAt : null,
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

  router.patch('/settings', (req, res) => {
    const data = store.load();
    const payload = req.body || {};
    let touched = 0;
    Object.keys(payload).forEach((key) => {
      if (!(key in store.DEFAULT_SETTINGS)) return;
      const value = Number(payload[key]);
      if (!Number.isFinite(value) || value < 0) {
        throw new AppError(400, 'SETTINGS_VALUE_INVALID', '设置项 ' + key + ' 必须是不小于 0 的数字', { field: key });
      }
      if (Number(data.settings[key]) !== value) { data.settings[key] = value; touched += 1; }
    });
    if (touched === 0) {
      throw new AppError(400, 'PRICING_NO_CHANGE', '价格与参数都没有变化，不需要生成新版本');
    }
    const version = versions.publishVersion(data, {
      source: 'settings',
      reason: String(payload.reason || '').trim() || '修改全局计费参数',
      effectiveAt: payload.effectiveAt,
    });
    store.save(data);
    res.json({ settings: pricing.settingsOf(store.load()), versionNo: version.versionNo, effectiveAt: version.effectiveAt, changes: version.changes });
  });

  // ---- 计费规则版本 ----
  router.get('/pricing-versions', (req, res) => {
    res.json(versions.listVersions(store.load()));
  });

  router.get('/pricing-versions/effective', (req, res) => {
    const data = store.load();
    const at = String((req.query && req.query.at) || '').trim() || new Date().toISOString();
    const parsed = versions.parseFlexibleTime(at);
    if (!parsed) throw new AppError(400, 'PRICING_TIME_INVALID', '时刻要形如 2026-09-23 10:00', { field: 'at' });
    const version = pricing.effectiveVersionAt(data, parsed.toISOString());
    if (!version) throw new AppError(404, 'PRICING_NO_VERSION', '该时刻没有可用的计费规则版本');
    const latest = pricing.latestVersion(data);
    res.json({
      at: parsed.toISOString(),
      versionNo: version.versionNo,
      effectiveAt: version.effectiveAt,
      reason: version.reason,
      isLatest: latest && latest.versionNo === version.versionNo,
      snapshot: {
        settings: Object.assign({}, pricing.DEFAULT_SETTINGS, version.snapshot.settings || {}),
        zones: version.snapshot.zones || [],
      },
    });
  });

  router.get('/pricing-versions/diff', (req, res) => {
    res.json(versions.compareVersions(store.load(), req.query && req.query.a, req.query && req.query.b));
  });

  router.get('/pricing-versions/:no', (req, res) => {
    res.json({ version: versions.getVersionDetail(store.load(), req.params.no) });
  });

  // 直接发布一个新版本：body 里可以带任意全局参数（只传要改的项）
  router.post('/pricing-versions/publish', (req, res) => {
    const data = store.load();
    const payload = req.body || {};
    let touched = 0;
    pricing.SETTING_FIELDS.forEach((key) => {
      if (payload[key] === undefined || payload[key] === null || payload[key] === '') return;
      const value = Number(payload[key]);
      if (!Number.isFinite(value) || value < 0) {
        throw new AppError(400, 'SETTINGS_VALUE_INVALID', '设置项 ' + key + ' 必须是不小于 0 的数字', { field: key });
      }
      if (Number(data.settings[key]) !== value) { data.settings[key] = value; touched += 1; }
    });
    if (touched === 0) {
      throw new AppError(400, 'PRICING_NO_CHANGE', '价格与参数都没有变化，不需要生成新版本');
    }
    const version = versions.publishVersion(data, {
      source: 'manual',
      reason: String(payload.reason || '').trim() || '页面发布新版本',
      effectiveAt: payload.effectiveAt,
    });
    store.save(data);
    res.status(201).json({ versionNo: version.versionNo, effectiveAt: version.effectiveAt, changes: version.changes, snapshot: version.snapshot });
  });

  // 用两个版本分别试算同一批运单，给出逐单金额、差额与原因，以及差额合计
  router.post('/pricing-versions/compare-trial', (req, res) => {
    const data = store.load();
    const payload = req.body || {};
    const aNo = versions.resolveVersionNo(data, payload.versionA);
    const bNo = versions.resolveVersionNo(data, payload.versionB);
    if (aNo === bNo) throw new AppError(400, 'PRICING_SAME_VERSION', '请选两个不同的版本进行对比');
    const versionA = pricing.findVersion(data, aNo);
    const versionB = pricing.findVersion(data, bNo);

    let list = data.waybills.slice();
    if (Array.isArray(payload.waybillIds) && payload.waybillIds.length) {
      const wanted = new Set(payload.waybillIds.map(String));
      list = list.filter((waybill) => wanted.has(waybill.id));
    } else {
      if (payload.customerId) list = list.filter((waybill) => waybill.customerId === String(payload.customerId));
      if (payload.period) list = list.filter((waybill) => bills.periodOf(waybill) === String(payload.period));
      if (payload.status) list = list.filter((waybill) => waybill.status === String(payload.status));
      if (payload.unbilledOnly) list = list.filter((waybill) => !waybill.billId);
    }    if (list.length === 0) throw new AppError(400, 'PRICING_COMPARE_NO_WAYBILL', '所选范围内没有可试算的运单');

    const result = pricing.compareWaybillsByVersions(
      data,
      list,
      (waybill) => zones.zoneOfCity(data, waybill.toCity),
      (waybill) => {
        const customer = data.customers.find((item) => item.id === waybill.customerId);
        return customer || null;
      },
      versionA,
      versionB
    );
    res.json(result);
  });

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
