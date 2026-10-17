# NESLink

在浏览器里运行 NES 游戏的平台，目标是支持多人联机（输入同步 + 回滚）。

当前进度：**M0 单机**。可以载入本地 `.nes` 文件，画面、声音、键盘和手柄输入都已接通，支持即时存档。ROM 和存档只保存在浏览器的 IndexedDB 里。

## 目录结构

```
apps/web        Next.js 前端（游戏库、播放器）
packages/core   模拟器核心接口、jsnes 适配、输入映射、Worker 消息协议
```

模拟器跑在 Web Worker 里（`apps/web/lib/emulator/emulator.worker.ts`），通过 OffscreenCanvas 直接绘制画面，音频则直接推给 AudioWorklet（`apps/web/public/audio-worklet.js`）。

## 开发

```bash
pnpm install
pnpm dev         # http://localhost:3000
pnpm lint
pnpm typecheck
pnpm build
```

## 默认按键

| | 1P | 2P |
|---|---|---|
| 方向 | W A S D | 方向键 |
| B / A | J / K | 小键盘 1 / 2 |
| Select / Start | V / B | 小键盘 5 / 小键盘 Enter |

手柄（标准映射）按连接顺序分配给 1P、2P。
