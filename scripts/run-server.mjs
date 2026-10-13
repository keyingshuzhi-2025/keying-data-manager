/**
 * 开发/运行包装器：以可见日志启动打包产物。
 *
 * 为什么需要它：.env 里配置了 LOG_FILE=./logs/server.log 时，pino 日志全部写入
 * 文件，终端（尤其是 concurrently 的 [server] 面板）完全静默——无法直观判断
 * 服务是否已在 3000 端口监听。本包装器在加载产物前清空 LOG_FILE，
 * 使日志直接打印到终端；dotenv 不会覆盖已存在的环境变量，因此该覆盖生效。
 *
 * 同时显式捕获启动失败（端口占用等）并给出可读的原因。
 */
// 必须在 import 服务产物之前设置：dotenv 不会覆盖已存在的变量，
// 空字符串由 config.ts 解析为“未配置”→ 日志走终端 stdout
process.env.LOG_FILE = '';

process.on('unhandledRejection', (reason) => {
  console.error('[server] 未处理的 Promise 拒绝：', reason);
});

const mod = await import('../dist/server-bundle.mjs');

try {
  await mod.startServer();
} catch (error) {
  const code = (error ?? {}).code;
  if (code === 'EADDRINUSE') {
    console.error('[server] 端口 3000 已被占用：请结束占用该端口的进程后重试，或设置 PORT 换端口。');
    console.error('        查看占用：netstat -ano | findstr :3000');
  } else {
    console.error('[server] 启动失败：', error?.stack ?? error);
  }
  process.exit(1);
}
