export const TOMATO_EXCLUDED_STATUSES = Object.freeze([
  "测试通过",
  "测试完成",
  "不修复",
  "已取消",
]);

const EXCLUDED_STATUS_SET = new Set(TOMATO_EXCLUDED_STATUSES);

export function isVisibleTomatoStatus(status) {
  return !EXCLUDED_STATUS_SET.has(status);
}
