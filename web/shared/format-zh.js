// Chinese wording for shared/format.js (the console and the portal both use it). This file is the
// only place where that module holds Chinese text, like a zh message dictionary.
export const ZH = {
  minute: '分',
  second: '秒',
  hour: '小时',
  justNow: '刚刚',
  minutesAgo: '分钟前',
  hoursAgo: '小时前',
  daysAgo: '天前',
  /** "11月5日", with the year first when it is not the current one: "2025年11月5日". */
  date: (d, sameYear) =>
    `${sameYear ? '' : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日`,
};
