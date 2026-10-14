import "./style.css";
import "./intro.css";
import "./pages.css";
import { goals, routeInfo, pick } from "./content";
import { renderPage, pageMeta, goalResult } from "./render";
import { validateInquiry } from "./contact-validation.mjs";
import { setupMotion } from "./motion";

const { locale } = routeInfo(location.pathname);
const root = document.querySelector<HTMLDivElement>("#app")!;
if (!root.querySelector("main")) root.innerHTML = renderPage(location.pathname);
document.title = pageMeta(location.pathname).title;
document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
const menu = document.querySelector<HTMLButtonElement>(".menu-toggle")!;
const nav = document.querySelector<HTMLElement>(".nav")!;
function closeMenu() { menu.setAttribute("aria-expanded", "false"); nav.classList.remove("open"); }
menu.addEventListener("click", () => { const open = menu.getAttribute("aria-expanded") !== "true"; menu.setAttribute("aria-expanded",String(open)); nav.classList.toggle("open",open); });
document.addEventListener("keydown",event => { if(event.key === "Escape" && menu.getAttribute("aria-expanded") === "true") { closeMenu(); menu.focus(); } });
nav.addEventListener("click", closeMenu);

function selectGoal(id: string) {
  if (!goals.some(g=>g.id===id)) return;
  const result=document.querySelector<HTMLElement>("#goal-result");
  if(!result) return;
  document.querySelectorAll<HTMLButtonElement>("[data-goal]").forEach(button=>button.setAttribute("aria-pressed",String(button.dataset.goal===id)));
  result.innerHTML=goalResult(locale,id,result.dataset.detail==="true");
}
document.querySelectorAll<HTMLButtonElement>("[data-goal]").forEach(button=>button.addEventListener("click",()=>selectGoal(button.dataset.goal!)));
const queryNeed=new URLSearchParams(location.search).get("need");
if(queryNeed) selectGoal(queryNeed);

const form=document.querySelector<HTMLFormElement>("#inquiry-form");
if(form) {
  const need=form.elements.namedItem("need") as HTMLSelectElement;
  if(queryNeed && [...need.options].some(o=>o.value===queryNeed)) need.value=queryNeed;
  function setContactMode(mode: string) {
    document.querySelectorAll<HTMLButtonElement>("[data-contact-mode]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.contactMode===mode)));
    document.querySelector<HTMLElement>(".china-guidance")!.hidden=mode!=="china";
    if(mode==="international" && !need.value) need.value="global";
  }
  if(queryNeed==="global") setContactMode("international");
  document.querySelectorAll<HTMLButtonElement>("[data-contact-mode]").forEach(b=>b.addEventListener("click",()=>setContactMode(b.dataset.contactMode!)));
  document.querySelectorAll<HTMLButtonElement>("[data-inquiry-need]").forEach(b=>b.addEventListener("click",()=>{need.value=b.dataset.inquiryNeed!; need.focus();}));
  form.addEventListener("submit",async event=>{
    event.preventDefault();
    const status=document.querySelector<HTMLElement>("#form-status")!;
    const submit=form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    if(submit.disabled || !form.reportValidity()) return;
    const data=new FormData(form);
    const inquiry={...Object.fromEntries(data),consent:data.get("consent")==="on",locale};
    const validation=validateInquiry(inquiry);
    if(!validation.ok) {status.textContent=pick(locale,"请检查输入内容、邮箱与隐私授权。","Please check the fields, email and privacy consent."); return;}
    submit.disabled=true;
    status.textContent=pick(locale,"正在发送咨询，请稍候……","Sending your inquiry…");
    try {
      const response=await fetch("/api/website-contact",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(inquiry),signal:AbortSignal.timeout(20000)});
      const receipt=await response.json();
      if(!response.ok) {
        status.textContent=response.status===503 ? pick(locale,"咨询收件服务尚未开通。内容已保留在当前页面，暂未发送，请勿重复提交。","Inquiry delivery is not yet enabled. Your text remains on this page and has not been sent. Please do not resubmit.") : response.status===429 ? pick(locale,"提交过于频繁，请十分钟后重试。","Too many attempts. Please try again in ten minutes.") : pick(locale,"暂未取得发送回执。请保留当前内容，稍后确认，避免重复提交。","No sending receipt was received. Keep your message and check later to avoid duplicate submissions.");
      } else if(receipt.status==="sent" && typeof receipt.reference==="string") {
        status.textContent=pick(locale,`咨询已发送。回执编号：${receipt.reference}`,`Inquiry sent. Reference: ${receipt.reference}`);
        form.reset();
      } else throw new Error("INVALID_RECEIPT");
    } catch {status.textContent=pick(locale,"连接未完成，暂无法确认是否送达。请保留内容，勿立即重复提交。","The connection did not complete, so delivery is uncertain. Keep your message and avoid an immediate retry.");}
    finally {submit.disabled=false;}
  });
}
setupMotion(locale);
