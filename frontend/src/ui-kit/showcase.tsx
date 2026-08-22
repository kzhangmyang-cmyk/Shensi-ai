import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AppShell,
  Button,
  EmptyState,
  Modal,
  Panel,
  SelectField,
  SkeletonRows,
  StatusTag,
  Tabs,
  TextAreaField,
  TextField,
  Toast,
  type UiTheme
} from "./components";
import "./ui-kit.css";

const TOKEN_GROUPS = [
  {
    title: "颜色",
    items: [
      ["背景", "var(--ui-bg)"],
      ["基础表面", "var(--ui-surface)"],
      ["强调色", "var(--ui-accent)"],
      ["正文", "var(--ui-text)"],
      ["弱化文字", "var(--ui-muted)"]
    ]
  },
  {
    title: "间距",
    items: [
      ["4", "var(--space-1)"],
      ["8", "var(--space-2)"],
      ["12", "var(--space-3)"],
      ["16", "var(--space-4)"],
      ["24", "var(--space-6)"]
    ]
  },
  {
    title: "圆角与阴影",
    items: [
      ["控件圆角", "var(--radius-control)"],
      ["面板圆角", "var(--radius-panel)"],
      ["浮层圆角", "var(--radius-overlay)"],
      ["轻阴影", "var(--shadow-1)"],
      ["浮层阴影", "var(--shadow-3)"]
    ]
  }
];

const LEADS = [
  {
    company: "Northstar Components",
    country: "英国",
    owner: "Shirley",
    source: "自动获客",
    status: "待核验",
    tone: "warning" as const
  },
  {
    company: "Lumen Industrial",
    country: "德国",
    owner: "陈明",
    source: "展会导入",
    status: "跟进中",
    tone: "info" as const
  },
  {
    company: "Pacific Tooling",
    country: "新加坡",
    owner: "林嘉",
    source: "官网询盘",
    status: "已转化",
    tone: "success" as const
  }
];

function TokenPreview() {
  return (
    <section className="showcase-section" id="tokens">
      <div className="section-heading">
        <h2>设计 Token</h2>
        <p>所有组件只引用语义变量，切换主题时无需修改组件结构。</p>
      </div>
      <div className="token-layout">
        <Panel title="颜色与材质" description="背景、表面、文字和强调色">
          <div className="color-swatches">
            {[
              ["页面背景", "ui-bg"],
              ["基础表面", "ui-surface"],
              ["次级表面", "ui-surface-2"],
              ["强调色", "ui-accent"],
              ["正文", "ui-text"]
            ].map(([label, token]) => (
              <div className="color-swatch" key={token}>
                <span style={{ background: `var(--${token})` }} />
                <strong>{label}</strong>
                <code>--{token}</code>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="排版层级" description="中文产品界面的紧凑字阶">
          <div className="type-scale">
            <div className="type-scale__display">经营决策工作台</div>
            <div className="type-scale__title">客户增长与线索管理</div>
            <div className="type-scale__body">
              清晰呈现数据、动作和系统反馈，确保业务人员不需要学习设计语言。
            </div>
            <div className="type-scale__caption">辅助说明与字段提示</div>
          </div>
        </Panel>
      </div>
      <div className="token-reference">
        {TOKEN_GROUPS.map((group) => (
          <div key={group.title}>
            <h3>{group.title}</h3>
            {group.items.map(([label, token]) => (
              <p key={label}>
                <span>{label}</span>
                <code>{token}</code>
              </p>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function ActionPreview({
  activeTab,
  setActiveTab,
  onOpenModal,
  onToast
}: {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  onOpenModal: () => void;
  onToast: () => void;
}) {
  return (
    <section className="showcase-section" id="actions">
      <div className="section-heading">
        <h2>按钮、输入与选择</h2>
        <p>覆盖默认、悬停、聚焦、禁用、错误和处理中状态。</p>
      </div>
      <div className="showcase-grid showcase-grid--actions">
        <Panel title="按钮" description="每种按钮只表达一种操作优先级">
          <div className="button-stack">
            <Button variant="primary" onClick={onToast}>
              保存并继续
            </Button>
            <Button variant="secondary" onClick={onOpenModal}>
              打开弹窗
            </Button>
            <Button variant="ghost">取消操作</Button>
            <Button variant="danger">移入垃圾箱</Button>
            <Button loading>提交中</Button>
            <Button disabled>不可用</Button>
          </div>
        </Panel>
        <Panel title="表单控件" description="标签始终位于控件上方">
          <div className="form-grid">
            <TextField
              id="company"
              label="公司名称"
              defaultValue="Northstar Components"
              helper="请输入工商或官网使用的完整名称"
            />
            <SelectField id="region" label="国家或地区" defaultValue="uk">
              <option value="uk">英国</option>
              <option value="de">德国</option>
              <option value="sg">新加坡</option>
            </SelectField>
            <TextField
              id="email"
              label="联系邮箱"
              defaultValue="sales@northstar.example"
              error="请使用公司域名邮箱"
            />
            <TextAreaField
              id="notes"
              label="核验说明"
              defaultValue="官网产品与目标采购方向匹配，建议继续确认联系人。"
              helper="最多输入 200 字"
            />
          </div>
        </Panel>
      </div>
      <Panel title="标签页与状态标签">
        <Tabs
          ariaLabel="线索状态筛选"
          active={activeTab}
          onChange={setActiveTab}
          items={[
            { id: "all", label: "全部", count: 18 },
            { id: "verify", label: "待核验", count: 4 },
            { id: "follow", label: "跟进中", count: 7 },
            { id: "converted", label: "已转化", count: 3 }
          ]}
        />
        <div className="status-row">
          <StatusTag>未处理</StatusTag>
          <StatusTag tone="info">跟进中</StatusTag>
          <StatusTag tone="success">已转化</StatusTag>
          <StatusTag tone="warning">待核验</StatusTag>
          <StatusTag tone="danger">已驳回</StatusTag>
        </div>
      </Panel>
    </section>
  );
}

function DataPreview() {
  return (
    <section className="showcase-section" id="data">
      <div className="section-heading">
        <h2>窗口、面板与数据行</h2>
        <p>面板承担真实层级，普通数据行只用轻量分隔。</p>
      </div>
      <div className="window">
        <header className="window__bar">
          <div>
            <strong>候选线索</strong>
            <span>示例数据，未连接接口</span>
          </div>
          <div>
            <Button variant="secondary">导出列表</Button>
            <Button variant="primary">新增线索</Button>
          </div>
        </header>
        <div className="table-wrap">
          <table className="ui-table">
            <thead>
              <tr>
                <th>公司</th>
                <th>国家或地区</th>
                <th>负责人</th>
                <th>来源</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {LEADS.map((lead) => (
                <tr key={lead.company}>
                  <td>
                    <strong>{lead.company}</strong>
                    <small>industrial components</small>
                  </td>
                  <td>{lead.country}</td>
                  <td>{lead.owner}</td>
                  <td>{lead.source}</td>
                  <td>
                    <StatusTag tone={lead.tone}>{lead.status}</StatusTag>
                  </td>
                  <td>
                    <Button variant="ghost">查看详情</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function StatePreview({
  onToast
}: {
  onToast: () => void;
}) {
  return (
    <section className="showcase-section" id="states">
      <div className="section-heading">
        <h2>通知、空状态与加载状态</h2>
        <p>反馈信息与真实内容保持相同结构，减少加载完成后的跳动。</p>
      </div>
      <div className="showcase-grid showcase-grid--states">
        <Panel title="空状态">
          <EmptyState
            title="还没有可展示的线索"
            description="调整筛选条件，或从获客模块添加第一条候选线索。"
            action={
              <Button variant="primary" onClick={onToast}>
                添加线索
              </Button>
            }
          />
        </Panel>
        <Panel title="加载状态">
          <SkeletonRows count={3} />
        </Panel>
      </div>
      <div className="notification-stack" aria-label="通知示例">
        <div className="inline-notice inline-notice--info">
          <strong>系统提示</strong>
          <span>本页为组件预览，不会写入业务数据。</span>
        </div>
        <div className="inline-notice inline-notice--success">
          <strong>保存成功</strong>
          <span>主题与组件状态已保存在当前浏览器。</span>
        </div>
        <div className="inline-notice inline-notice--danger">
          <strong>连接失败</strong>
          <span>请检查网络后重试，本地草稿不会丢失。</span>
        </div>
      </div>
    </section>
  );
}

function Showcase() {
  const [theme, setTheme] = useState<UiTheme>(() => {
    const stored = localStorage.getItem("goodjob-ui-theme");
    return stored === "warm" ? "warm" : "dark";
  });
  const [activeTab, setActiveTab] = useState("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [toastVisible, setToastVisible] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme === "dark" ? "dark" : "light";
    localStorage.setItem("goodjob-ui-theme", theme);
  }, [theme]);

  function showToast() {
    setToastVisible(true);
    window.setTimeout(() => setToastVisible(false), 3600);
  }

  return (
    <AppShell theme={theme} onThemeChange={setTheme}>
      <section className="overview" id="overview">
        <div>
          <h1>AI 营销系统 UI 基础</h1>
          <p>
            一套可直接复用的应用壳、表单、数据展示与系统状态组件。先统一设计语言，再连接真实业务。
          </p>
        </div>
        <div className="overview__summary">
          <div>
            <span>主题</span>
            <strong>2 套</strong>
          </div>
          <div>
            <span>组件组</span>
            <strong>12 组</strong>
          </div>
          <div>
            <span>当前模式</span>
            <strong>{theme === "warm" ? "明亮玻璃" : "暗黑玻璃"}</strong>
          </div>
        </div>
      </section>

      <TokenPreview />
      <ActionPreview
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onOpenModal={() => setModalOpen(true)}
        onToast={showToast}
      />
      <DataPreview />
      <StatePreview onToast={showToast} />

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="创建新的候选线索"
        description="这是弹窗组件示例，提交后不会保存业务数据。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setModalOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setModalOpen(false);
                showToast();
              }}
            >
              创建线索
            </Button>
          </>
        }
      >
        <div className="form-grid">
          <TextField id="modal-company" label="公司名称" placeholder="输入公司名称" />
          <SelectField id="modal-source" label="线索来源" defaultValue="website">
            <option value="website">官网询盘</option>
            <option value="finder">自动获客</option>
            <option value="event">展会导入</option>
          </SelectField>
        </div>
      </Modal>

      <Toast
        visible={toastVisible}
        title="操作完成"
        message="演示状态已更新，不会影响真实业务数据。"
        onClose={() => setToastVisible(false)}
      />
    </AppShell>
  );
}

createRoot(document.getElementById("ui-kit-root")!).render(
  <StrictMode>
    <Showcase />
  </StrictMode>
);
