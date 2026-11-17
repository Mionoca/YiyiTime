'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 文档 L637「刷新时机：onShow、子页返回、下拉刷新（子页）、写操作成功后」：
 * - 子页（非自定义导航）必须在页面 json 打开 enablePullDownRefresh，否则手势不触发；
 * - 打开后页面 js 的 onPullDownRefresh 里必须调用 wx.stopPullDownRefresh()，
 *   否则用户会一直看到转圈（失败分支也要收起）。
 * M8 起首页也回归默认导航 + 可滚动卡片流，所以要一起纳入检查；
 * 任何页面改回 navigationStyle: custom 都会被这里的名单变化拦住。
 */
const ROOT = path.join(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
const app = JSON.parse(fs.readFileSync(path.join(MINI, 'app.json'), 'utf8'));

function pageJson(page) {
  return JSON.parse(fs.readFileSync(path.join(MINI, page + '.json'), 'utf8'));
}

function subPages() {
  return app.pages.filter((page) => pageJson(page).navigationStyle !== 'custom');
}

/** 去掉行注释与块注释（字符串里的 // 不是本文件要防的场景，页面 js 也没有） */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/.*$/gm, '');
}

/** 取对象方法（含大括号体）的源码，用于把「定义了 stop 但没调用」与「真的调用了」区分开 */
function methodBody(src, name) {
  const match = new RegExp('\\b' + name + '\\s*\\([^)]*\\)\\s*\\{').exec(src);
  if (!match) return null;
  let i = match.index + match[0].length;
  let depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') depth -= 1;
    i += 1;
  }
  return depth === 0 ? src.slice(match.index, i) : null;
}

test('pull-down: 非自定义导航的子页都开启了 enablePullDownRefresh（文档 L637）', () => {
  assert.deepStrictEqual(subPages().slice().sort(), [
    'pages/bind/index',
    'pages/diary/index',
    'pages/home/index',
    'pages/ledger/index',
    'pages/mood/index',
    'pages/profile/index',
    'pages/safety/index',
    'pages/wish/index',
  ]);
  for (const page of subPages()) {
    assert.strictEqual(pageJson(page).enablePullDownRefresh, true, page + ' 未开启下拉刷新');
  }
});

test('pull-down: onPullDownRefresh 处理器内必须调用 wx.stopPullDownRefresh', () => {
  for (const page of subPages()) {
    const js = stripComments(fs.readFileSync(path.join(MINI, page + '.js'), 'utf8'));
    const body = methodBody(js, 'onPullDownRefresh');
    if (!body) {
      assert.fail(page + ' 没有 onPullDownRefresh');
    }
    assert.match(body, /wx\.stopPullDownRefresh\s*\(/, page + ' 的 onPullDownRefresh 没有收起转圈');
  }
  // M8：首页不再是「一屏场景」，卡片流可滚动，靠系统下拉刷新（文档 9.9）
  const home = pageJson('pages/home/index');
  assert.strictEqual(home.enablePullDownRefresh, true);
  assert.notStrictEqual(home.navigationStyle, 'custom', '首页已回归默认导航栏');
  assert.notStrictEqual(home.disableScroll, true, '首页卡片流要能滚动');
});
