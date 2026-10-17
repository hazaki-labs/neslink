# NESLink

在浏览器里运行 NES 游戏的平台，目标是支持多人联机（输入同步 + 回滚）。

当前进度：**M1 两人联机（锁步）**。

- 单机：载入本地 `.nes` 文件游玩，支持即时存档。ROM 和存档只保存在浏览器的 IndexedDB 里，不会上传。
- 联机：在游戏库里点「联机」创建房间，把邀请链接发给对方。对方需要载入自己的同一个 ROM（按 SHA-1 校验），两人都入座后由房主开始。双方从开机状态同时运行，只交换每帧的手柄输入；每 60 帧比对一次内存哈希，用来检测画面是否不同步。

## 目录结构

```
apps/web           Vite + React 前端（游戏库、播放器、房间大厅），构建产物是纯静态文件
apps/server        Cloudflare Worker：托管前端静态文件和 /api；每个房间一个 Durable Object，负责入座、转发输入、比对哈希
packages/core      模拟器核心接口、WASM 核心适配、输入映射、帧节奏、Worker 消息协议、联机协议与锁步会话
packages/nes-wasm  Rust 包装层：tetanes-core 编译为 WebAssembly（wasm-bindgen）
```

模拟器跑在 Web Worker 里（`apps/web/src/lib/emulator/emulator.worker.ts`），通过 OffscreenCanvas 直接绘制画面，音频则直接推给 AudioWorklet（`apps/web/public/audio-worklet.js`）。

## 开发

`packages/nes-wasm/pkg` 是编译好的 WASM 产物，已经提交到仓库，所以只改前端时不需要 Rust。修改 Rust 代码后需要重新构建，依赖 Rust stable、`wasm32-unknown-unknown` target，以及与 `Cargo.lock` 中 wasm-bindgen 版本一致的 `wasm-bindgen-cli`：

```bash
pnpm build:wasm
```

```bash
pnpm install
pnpm dev         # 同时启动 Vite（http://localhost:5173）和 wrangler dev（:8787，/api 经 Vite 代理）
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

## 部署（Cloudflare）

前端和联机服务部署为同一个 Worker（`apps/server/wrangler.jsonc`），首次部署前需要先登录 Cloudflare：

```bash
pnpm --filter @neslink/server exec wrangler login
```

```bash
pnpm deploy
```

## 默认按键

| | 1P | 2P |
|---|---|---|
| 方向 | W A S D | 方向键 |
| B / A | J / K | 小键盘 1 / 2 |
| Select / Start | V / B | 小键盘 5 / 小键盘 Enter |

手柄（标准映射）按连接顺序分配给 1P、2P。联机时你的座位由房间分配，用哪一套按键或手柄都可以。
