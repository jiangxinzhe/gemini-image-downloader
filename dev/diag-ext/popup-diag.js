'use strict';
const out = document.getElementById('out');

function line(t) {
  out.textContent += '\n' + t;
  console.log('[popup-diag]', t);
}

document.getElementById('go').addEventListener('click', async () => {
  try {
    line('1. 打开目录选择对话框…（对话框关闭后本行下方若继续输出，说明弹窗存活）');
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    line('2. 弹窗存活 ✓ 已选择目录: ' + dir.name);

    const perm = await dir.requestPermission({ mode: 'readwrite' });
    line('3. 写权限: ' + perm);
    if (perm !== 'granted') return;

    const resp = await fetch('https://lh3.googleusercontent.com/a/default-user=s64');
    const blob = await resp.blob();
    line('4. 抓图成功: ' + blob.type + ' ' + blob.size + 'B');

    const name = 'popup-diag-' + Date.now() + '.png';
    const fh = await dir.getFileHandle(name, { create: true });
    const ws = await fh.createWritable();
    await ws.write(blob);
    await ws.close();
    line('5. 写盘成功: ' + dir.name + '/' + name);
    line('—— 弹窗内完整流程通过 ——');
  } catch (e) {
    line('ERR name=' + (e && e.name) + ' msg=' + String((e && e.message) || e));
  }
});
