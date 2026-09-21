const button = document.getElementById('capture');
const status = document.getElementById('status');
button.addEventListener('click', async () => {
  button.disabled = true; status.textContent = '正在读取当前页…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url || 'about:blank');
    if (url.origin !== 'https://aiqicha.baidu.com' || url.pathname !== '/s') throw new Error('请先打开爱企查企业搜索结果页');
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['capture.js'] });
    if (!result?.result?.ok) throw new Error(result?.result?.message || '未读取到当前页企业');
    const response = await chrome.runtime.sendNativeMessage('com.shensi.enterprise_preview', result.result.capture);
    if (!response?.ok) throw new Error(response?.message || '本机桥接未就绪');
    status.textContent = `已发送 ${response.count} 家企业到本机预览。打开 Shensi 企业查询，点击“读取浏览器预览”；尚未保存客户。`;
  } catch (error) { status.textContent = `读取失败：${error.message}`; }
  finally { button.disabled = false; }
});
