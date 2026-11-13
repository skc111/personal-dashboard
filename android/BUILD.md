# 安卓构建

安卓界面来自 `../static/`，以本地 WebView 运行。网络同步由原生 WebDAV 桥访问用户自己的坚果云，不需要电脑或 Python 服务。

需要：JDK 17、Android platform 35、build-tools 35.0.0；脚本使用 aapt2、javac、d8、zipalign、apksigner，不依赖 Gradle。

准备以下 Maven Central 依赖的 JAR，放进同一个本地目录：

- `com.squareup.okhttp3:okhttp:4.12.0`
- `com.squareup.okio:okio-jvm:3.6.0`
- `org.jetbrains.kotlin:kotlin-stdlib:1.9.10`
- `org.jetbrains:annotations:13.0`

```bash
JAVA_HOME=/path/to/jdk-17 \
ANDROID_HOME=/path/to/android-sdk \
ANDROID_LIBS=/path/to/jars \
bash android/build.sh
```

输出 `android/dist/personal-dashboard-1.0.2.apk`（文件名跟随 Manifest 的版本，构建前校验与 `package.json` 一致）。最低 Android 8.0，目标 API 35，签名 v2/v3。

首次自行编译会生成自己的私密签名文件；`android/signing/` 必须留在本机。使用自己的密钥签名后不能直接覆盖他人签名的安装包，请先导出数据再迁移。

维护者升级版本时沿用原签名密钥并递增 Manifest 的 `versionCode`。将 APK 连同第三方许可打成安卓发布 ZIP：

```bash
python3 tools/package_release.py --output ../release-artifacts \
  --apk android/dist/personal-dashboard-1.0.2.apk
```

不要把编译目录、签名目录、用户 `data/` 放入仓库或发布包。第三方许可见仓库 `THIRD_PARTY_NOTICES.md` 和 `licenses/`。

## UI 升级自检

- 原包名、签名密钥、`offline-state.json`、`sync-secret` 和 Keystore alias 不变；不要先卸载旧版。
- `npm run test:browser` 包含虚构的历史日程保留、六个页面、长表单触摸滑动、长标题、大字与小高度视口测试；不连接日常使用的服务。
- 浏览器缩小视口只能模拟键盘占位。发布前还应在真机检查：手势导航 / 三键导航、横竖屏、主题切换、输入时滚动、收起键盘、保存后关闭，以及覆盖安装后的记录和账号。
- 系统边距由原生容器统一处理，WebView 使用剩余内容区域，不能再硬编码系统导航栏高度。
