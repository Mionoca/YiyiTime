/**
 * 轻振动反馈（技术设计文档 8.9：「振动反馈只用于抱抱 / 报平安成功，且可关闭」）。
 * 默认开启，关闭状态存在本地，任何异常都不影响主流程。
 */
const STORAGE_KEY = 'haptics_enabled';

function isEnabled() {
  try {
    const value = wx.getStorageSync(STORAGE_KEY);
    // 没存过（undefined / ''）按默认开启；显式存 false 才关闭
    return value === undefined || value === null || value === '' ? true : !!value;
  } catch (err) {
    return true;
  }
}

/** 返回是否真的写进本地：写失败时调用方要回滚 UI，不能显示「已关闭」但实际还在振动 */
function setEnabled(on) {
  try {
    wx.setStorageSync(STORAGE_KEY, !!on);
    return true;
  } catch (err) {
    return false;
  }
}

/** 成功反馈用 light；没有 vibrateShort 的机型/基础库直接跳过 */
function light() {
  if (!isEnabled()) return;
  if (typeof wx === 'undefined' || typeof wx.vibrateShort !== 'function') return;
  try {
    wx.vibrateShort({ type: 'light', fail() {} });
  } catch (err) {
    // 振动失败不影响业务
  }
}

module.exports = { STORAGE_KEY, isEnabled, setEnabled, light };