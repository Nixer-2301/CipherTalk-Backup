const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const FRAMEWORK_NAME = 'WCDB';
const SOURCE_DYLIB_NAME = 'libWCDB.dylib';
const FALLBACK_VERSION = 'A';

/**
 * 从 dylib 的 install_name 解析期望的 framework 版本号。
 *
 * libWCDB.dylib 的 install_name 形如：
 *   @rpath/WCDB.framework/Versions/2.1.15/WCDB
 *
 * 解析失败时回退到 macOS framework 默认版本 "A"。
 */
function detectFrameworkVersion(dylibPath) {
    try {
        const result = spawnSync('otool', ['-D', dylibPath], { encoding: 'utf8' });
        if (result.status !== 0) return FALLBACK_VERSION;
        const match = result.stdout.match(/WCDB\.framework\/Versions\/([^/]+)\/WCDB/);
        if (match && match[1]) return match[1];
    } catch (error) {
        // ignore，回退默认值
    }
    return FALLBACK_VERSION;
}

function safeUnlink(targetPath) {
    try {
        fs.unlinkSync(targetPath);
    } catch (error) {
        if (error && error.code !== 'ENOENT') throw error;
    }
}

/**
 * 在 mac App 包内构造 WCDB.framework 目录结构。
 *
 * 这个修复存在的原因：
 *
 *   libwcdb_api.dylib 编译时硬链接 @rpath/WCDB.framework/Versions/<ver>/WCDB，
 *   但 native 构建产物把 WCDB 主二进制扁平化为 libWCDB.dylib 放在
 *   resources/macos/，extraResources 复制后落在 Contents/Resources/resources/macos/。
 *
 *   dyld 在运行时按 framework 路径找不到主二进制，会抛出：
 *     Library not loaded: @rpath/WCDB.framework/Versions/<ver>/WCDB
 *     Reason: tried: '<App>/Contents/Frameworks/WCDB.framework/Versions/<ver>/WCDB' (no such file)
 *
 *   导致 GUI 解密入口报 "WCDB 初始化异常: Failed to load shared library"，
 *   App 实际无法工作。
 *
 * 修复办法：
 *
 *   把 Contents/Resources/resources/macos/libWCDB.dylib 按标准 framework 结构
 *   布到 Contents/Frameworks/WCDB.framework/，并 ad-hoc 重签名。
 *
 *   不删除原 libWCDB.dylib（保留作为后向兼容来源 / 后备）。
 */
function setupMacosWcdbFramework(context) {
    if (context.electronPlatformName !== 'darwin') return;

    const productName = context.packager?.appInfo?.productFilename || 'CipherTalk';
    const appBundle = path.join(context.appOutDir, `${productName}.app`);
    if (!fs.existsSync(appBundle)) {
        console.warn(`[macos-wcdb-framework] App bundle 不存在，跳过: ${appBundle}`);
        return;
    }

    const sourceDylib = path.join(
        appBundle, 'Contents', 'Resources', 'resources', 'macos', SOURCE_DYLIB_NAME
    );
    if (!fs.existsSync(sourceDylib)) {
        console.warn(`[macos-wcdb-framework] 源 dylib 不存在，跳过: ${sourceDylib}`);
        return;
    }

    const version = detectFrameworkVersion(sourceDylib);
    const frameworkDir = path.join(
        appBundle, 'Contents', 'Frameworks', `${FRAMEWORK_NAME}.framework`
    );
    const versionedDir = path.join(frameworkDir, 'Versions', version);
    const versionedBinary = path.join(versionedDir, FRAMEWORK_NAME);
    const currentSymlink = path.join(frameworkDir, 'Versions', 'Current');
    const topSymlink = path.join(frameworkDir, FRAMEWORK_NAME);

    console.log(`[macos-wcdb-framework] 构建 ${FRAMEWORK_NAME}.framework (version=${version})`);

    // 1. 目录结构
    fs.mkdirSync(versionedDir, { recursive: true });

    // 2. 复制主二进制
    fs.copyFileSync(sourceDylib, versionedBinary);
    fs.chmodSync(versionedBinary, 0o755);

    // 3. Versions/Current → <version>
    safeUnlink(currentSymlink);
    fs.symlinkSync(version, currentSymlink);

    // 4. WCDB → Versions/Current/WCDB
    safeUnlink(topSymlink);
    fs.symlinkSync(path.join('Versions', 'Current', FRAMEWORK_NAME), topSymlink);

    // 5. ad-hoc 重签名（修改了 framework 内容，原签名失效）
    try {
        execFileSync('codesign', ['--force', '--sign', '-', versionedBinary], { stdio: 'inherit' });
        execFileSync('codesign', ['--force', '--sign', '-', frameworkDir], { stdio: 'inherit' });
        console.log(`[macos-wcdb-framework] 已 ad-hoc 重签名`);
    } catch (error) {
        // 不阻断打包，但要让构建日志清楚提示
        console.warn(`[macos-wcdb-framework] codesign 失败（继续）: ${String(error)}`);
    }

    console.log(`[macos-wcdb-framework] 完成: ${frameworkDir}`);
}

module.exports = { setupMacosWcdbFramework };
