import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['package.json', 'dsh.plugin.json', 'package-lock.json'];
const remote = 'origin';

function run(command, args, { inherit = false, optional = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (optional && result.status === 1) return '';
    throw new Error(`${command} ${args.join(' ')} 失败${result.stderr?.trim() ? `：${result.stderr.trim()}` : ''}`);
  }
  return result.stdout?.trim() ?? '';
}

const git = (args, options) => run('git', args, options);
const tagRef = (version) => `refs/tags/v${version}`;
const message = (version) => `chore(release): v${version}`;

function requireCleanTree() {
  if (git(['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('工作区有未提交的修改，请先提交或暂存（git stash）后再执行 npm run release。');
  }
}

function release() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--dry-run')) {
    throw new Error('用法：npm run release [-- --dry-run]；每次自动增加一个补丁版本。');
  }
  const dryRun = args.includes('--dry-run');
  requireCleanTree();
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { optional: true });
  if (!branch) throw new Error('当前处于 detached HEAD，请先切换到要发布的分支。');
  git(['ls-files', '--error-unmatch', '--', ...files]);
  git(['var', 'GIT_AUTHOR_IDENT']);
  git(['var', 'GIT_COMMITTER_IDENT']);

  const originals = files.map((file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
  const [pkg, plugin, lock] = originals.map((content) => JSON.parse(content));
  const current = pkg.version;
  if (typeof current !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(current)) {
    throw new Error(`package.json 版本必须为 x.y.z，当前为 ${current}。`);
  }
  if (plugin.version !== current || lock.version !== current || lock.packages?.['']?.version !== current) {
    throw new Error('package.json、dsh.plugin.json 和 package-lock.json 的版本不一致，请先修正并提交。');
  }
  const [major, minor, patch] = current.split('.');
  const next = `${major}.${minor}.${BigInt(patch) + 1n}`;
  const head = git(['rev-parse', 'HEAD']);
  const branchRef = `refs/heads/${branch}`;
  // Read and push the same destination, including repositories with a push URL.
  const destinations = git(['remote', 'get-url', '--push', '--all', remote]).split('\n');
  if (destinations.length !== 1) throw new Error('origin 必须只配置一个推送地址。');
  const destination = destinations[0];
  console.log(`检查 ${remote}/${branch}…`);
  const refs = git(['ls-remote', destination, branchRef,
    tagRef(current), `${tagRef(current)}^{}`, tagRef(next), `${tagRef(next)}^{}`]);
  const remoteRefs = new Map(refs.split('\n').filter(Boolean).map((line) => {
    const [oid, ref] = line.split(/\s+/);
    return [ref, oid];
  }));
  const remoteHead = remoteRefs.get(branchRef);
  if (remoteHead) {
    git(['fetch', '--no-tags', destination, branchRef]);
    // Use the fetched tip in case the branch moved after ls-remote.
    remoteRefs.set(branchRef, git(['rev-parse', 'FETCH_HEAD']));
    const result = spawnSync('git', ['merge-base', '--is-ancestor', 'FETCH_HEAD', head], { cwd: root });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`本地分支落后于 ${remote}/${branch} 或已分叉，请先同步后再发布。`);
  }

  const remoteCurrent = remoteRefs.get(`${tagRef(current)}^{}`) ?? remoteRefs.get(tagRef(current));
  const atReleaseCommit = git(['log', '-1', '--format=%s']) === message(current);
  if (atReleaseCommit && remoteCurrent && remoteCurrent !== head) {
    throw new Error(`远端 v${current} 指向其他提交，请先检查 tag 冲突。`);
  }
  const resume = atReleaseCommit && (!remoteCurrent || remoteRefs.get(branchRef) !== head);
  const version = resume ? current : next;
  const ref = tagRef(version);
  const localTag = git(['rev-parse', '--verify', '--quiet', ref], { optional: true });
  if (resume) {
    if (localTag && git(['rev-parse', `${ref}^{}`]) !== head) {
      throw new Error(`本地 v${version} 指向其他提交，请先检查 tag 冲突。`);
    }
    if (localTag && remoteRefs.has(ref) && localTag !== remoteRefs.get(ref)) {
      throw new Error(`本地和远端 v${version} 的 tag 对象不一致，请先处理冲突。`);
    }
    if (!localTag && remoteRefs.has(ref)) {
      throw new Error(`远端已有 v${version}，请先获取该 tag 后再重试。`);
    }
  } else if (localTag || remoteRefs.has(ref)) {
    throw new Error(`v${version} 已存在，停止发布以避免覆盖 tag。`);
  }

  console.log(resume ? `继续推送 v${version}，不重复增加版本。` : `发布版本：${current} → ${version}`);
  run(process.execPath, ['scripts/check.js'], { inherit: true });
  requireCleanTree();
  if (git(['rev-parse', 'HEAD']) !== head || git(['symbolic-ref', '--short', 'HEAD']) !== branch) {
    throw new Error('检查期间 Git 分支或提交发生变化，请重新执行。');
  }
  if (dryRun) {
    console.log(`[dry-run] 将${resume ? '续推' : '创建提交及'} v${version}，并将分支 ${branch} 与 tag 一起推送到 origin。未修改版本、提交或 tag。`);
    return;
  }

  if (!resume) {
    try {
      // Replace only the root version field; preserve each manifest's formatting.
      for (const [index, file] of files.entries()) {
        const content = file === 'package-lock.json'
          ? (() => {
            lock.version = version;
            lock.packages[''].version = version;
            return `${JSON.stringify(lock, null, 2)}\n`;
          })()
          : originals[index].replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
        writeFileSync(new URL(`../${file}`, import.meta.url), content);
      }
      git(['add', '--', ...files]);
      git(['commit', '-m', message(version), '--', ...files], { inherit: true });
    } catch (error) {
      // A rejected commit should leave the original versions ready for a retry.
      if (git(['rev-parse', 'HEAD']) === head) {
        git(['reset', '--quiet', 'HEAD', '--', ...files]);
        files.forEach((file, index) => writeFileSync(new URL(`../${file}`, import.meta.url), originals[index]));
      }
      throw error;
    }
  }

  try {
    if (!localTag) git(['tag', '-a', `v${version}`, '-m', message(version)], { inherit: true });
    requireCleanTree();
    git(['push', '--atomic', destination, `HEAD:${branchRef}`, `${ref}:${ref}`], { inherit: true });
  } catch (error) {
    throw new Error(`${error.message}\n本地发布提交已保留。解决错误后再次执行 npm run release，会继续推送 v${version}。`);
  }
  console.log(`已发布 v${version}：分支 ${branch} 和 tag 均已推送到 origin。`);
}

try {
  release();
} catch (error) {
  console.error(`发布停止：${error.message}`);
  process.exitCode = 1;
}
