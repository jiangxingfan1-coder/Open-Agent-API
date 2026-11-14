// 测试公共入口（package.json 的 test 脚本与 scripts/test-offline.mjs 用 `node --import` 预加载）：
// 把语言固定为中文，测试结果不随开发机或 CI（含 windows-latest）的系统区域变化。
// 测试文件会以子进程运行，环境变量随之继承；需要英文的测试自己传 OAA_LOCALE=en 或 Accept-Language。
process.env.OAA_LOCALE = 'zh';
