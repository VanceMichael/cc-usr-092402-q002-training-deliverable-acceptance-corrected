# 跨境实训成果签收流

这是一个保存课程批次、产出节点和签收记录的 Node.js 后端工程。SQLite 文件放在运行目录，迁移脚本位于 `migrations`，不依赖其他数据库或缓存服务。

启动：`docker build -t training-flow . && docker run --rm -p 8080:8080 training-flow`。本地测试：`npm test`。

## 开发检查

- 安装依赖：`npm install`
- 运行测试：`npm test`
- 编译或构建：`npm run build`
