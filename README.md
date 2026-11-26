# Jury

Jury 是一个本地运行的 Electron 多模型工作台：一次提问可并行调用多个大模型，比较回答、合并结论，并对结果进行交叉审查与仲裁。

![平台](https://img.shields.io/badge/platform-Windows-blue)
![框架](https://img.shields.io/badge/framework-Electron_44-47848f.svg)
![版本](https://img.shields.io/badge/version-1.5.5-green)

## 功能

- 多模型并行对话：流式显示各模型回答、思考过程、来源与终止状态。
- 图片与文档附件：支持粘贴/拖入图片，以及 txt、Markdown、代码、PDF、Word、Excel、PPT 等常见文件；支持 OCR 和文档全文提取。
- 多轮会话：新建、切换、搜索、重命名、置顶、删除，会话和附件均保存在本机。
- 编辑重发与单模型重试：可修改问题重建后续回答，也可只重试失败模型。
- 综合回答：支持本地智能合并，或调用指定模型生成结构化综合报告，并保留来源标记。
- 交叉审查：多个模型互审，再由仲裁模型汇总结论，帮助发现事实冲突与遗漏。
- 联网搜索：支持必应、Tavily、博查；部分服务商支持原生联网能力。
- 用量统计：记录服务端返回的输入、输出、缓存 token，估算花费，查看请求流水并导出 CSV。
- 模型管理：预置服务商和模型，支持自定义 OpenAI Chat Completions / Anthropic 端点，以及模型目录更新。
- 更新检查：从 GitHub Releases 检查新版本并打开下载页。
- 数据保险：分文件原子保存、自动备份、导入导出、窗口位置记忆，支持从旧版 Multi-Model Chat 数据迁移。
- 主题与窗口：支持亮色/暗色主题、自绘窗口控制按钮和最大化状态记忆。

## 安全与隐私

- API Key 和会话数据默认只保存在 `%APPDATA%\\Jury\\`。
- API Key 由 Electron `safeStorage` / Windows DPAPI 保护；渲染层只能看到是否已配置密钥。
- 渲染层启用沙箱、contextIsolation 和 CSP，网络请求由主进程白名单 API 发起。
- 文件路径需要经过系统文件选择授权；Markdown 链接仅允许 HTTP(S) 并交给系统浏览器打开。
- 导出的完整备份包含明文 API Key，请妥善保管。

## 运行与构建

```bash
npm install
npm start
npm test
npm run test:full
npm run icon
npm run dist
```

`npm test` 执行语法、CSS 和 Node 快速检查；`npm run test:full` 执行完整 Electron、端到端和性能套件。`npm run dist` 生成 Windows 安装版和便携版，产物位于 `dist/`。

## 目录

```text
src/main/        主进程、IPC、模型请求、存储、附件、搜索和更新检查
src/renderer/    聊天界面、设置、会话、用量、Markdown、综合与审查
scripts/         Node/Electron 测试、性能测试、图标和打包辅助脚本
```

## 下载

发布产物位于 [GitHub Releases](https://github.com/Alex-758/Jury/releases)。首次使用请打开“设置 → 模型配置”，填写服务商 API Key。

## License

MIT
