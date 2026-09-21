import "../replica-dashboard.css";
import "../vendor/phosphor/regular/style.css";
import "./view.css";
import "./preview.css";
import { mountEnterpriseQuery } from "./view";
import type { Enterprise } from "./model";

if (!import.meta.env.DEV) throw new Error("Preview is development-only");
const root = document.querySelector<HTMLElement>("#enterprise-preview")!;
const source = new DOMParser().parseFromString(await (await fetch("/index.html")).text(), "text/html");
const nav = source.querySelector(".replica-nav")?.outerHTML ?? "";
root.innerHTML = `<aside class="enterprise-preview-sidebar"><div class="enterprise-preview-brand"><img src="/assets/shensi-logo.png" alt="燊锶"><strong>燊锶</strong></div>${nav}</aside><main class="enterprise-preview-main"><header class="enterprise-preview-top">隔离示例预览 · 不连接真实客户池</header><h1>企业查询</h1><div id="enterprise-preview-content"></div></main>`;
root.querySelectorAll("nav button,nav a").forEach(button => {
  button.classList.toggle("active", (button as HTMLElement).dataset.replicaView === "enterprise-query");
  button.addEventListener("click", event => event.preventDefault());
});
const names = ["上海示例精密制造有限公司", "上海信创智能装备有限公司", "上海云航新材料科技有限公司", "上海睿联电子科技有限公司", "上海启航机电设备有限公司", "上海博远工业技术有限公司"];
const items: Enterprise[] = names.map((company, index) => ({ id: `isolated-${index}`, company, business: "制造业", country: "上海市", website: "", contact: "示例联系人", contactInfo: "示例联系方式（非真实）", description: ["专注于精密零部件的研发、生产与销售，为高端装备提供制造解决方案。", "从事工业自动化设备研发与集成，提供智能制造整体解决方案。", "新材料研发与生产，应用于电子、汽车及新能源领域。", "电子元器件及控制系统的研发、生产和技术服务。", "机电设备研发、制造与销售，提供定制化工业设备解决方案。", "工业软件与智能制造技术服务，助力企业数字化升级。"][index], status: "preview", sourceLabel: "隔离示例数据", tenantProspectId: `isolated-${index}`, leadId: `isolated-${index}` }));
items.forEach((item, index) => Object.assign(item, { size: ["500–999人", "100–499人", "1000人以上", "100–499人", "500–999人", "50–99人"][index], founded: ["2018-06-12", "2016-03-21", "2014-11-03", "2019-08-27", "2015-05-19", "2020-09-10"][index], creditCode: "示例信用代码（非真实）", capital: "5000万元（示例）", operatingStatus: "存续（示例）" }));
mountEnterpriseQuery(root.querySelector<HTMLElement>("#enterprise-preview-content")!, {
  async list() { return (new URLSearchParams(location.search).has("pagination") ? [...items, ...items.map(item => ({ ...item, id: `${item.id}-page2`, company: `${item.company}（分页示例）` }))] : items).map(item => ({ ...item })); },
  async join(item) { return `preview-${item.id}`; }
});
