# 账号服务常驻部署与恢复

本文件是可执行部署准备，进度和实际验收以`../PROJECT_STATUS.md`为准。
现有5680/5681仅为本机隔离验收，不能作为客户安装包的正式API。
正式部署前需确认一个部署落点：服务器地域与预算、可用云账户、固定域名。
本文不授权购买资源、公开真实后台、初始化真实运营者或迁移旧客户数据。

## 服务边界

`deploy/compose.cloud.yaml`复用现有Backend/Frontend镜像和Nginx，无新增身份平台。
首发单API实例，外部持久MySQL；禁止水平扩容绕过实例锁。所有外联执行默认关闭。
固定HTTPS域名同时提供客户API/网页和运营后台，运营HTML及`/api/platform/`
另受VPN/固定出口地址限制；MFA仍必须验证。客户密码恢复走
`https://已确认域名/account-recovery#reset`，凭证只填表单，不放URL。
公网不提供`/preview-access`测试凭据页。

## Cloudflare 免费层的临时境外入口

按当前源码，最低改动的域名布局是：官网`www.<域名>`使用Cloudflare Pages
托管`website/dist/`，产品和运营后台共用`app.<域名>`，由Cloudflare代理至
一台常驻境外主机上的现有Gateway/Express，并连接持久MySQL。客户网页与
`/api`必须保留同源，不能只将产品静态文件搬到Pages后让相对路径API失效。
Cloudflare免费静态托管不提供本项目所需的常驻Node进程、MySQL或备份；
主机、数据库、域名及邮件投递仍需独立资源和费用。Workers免费请求/CPU配额
也不是直接迁移当前Express与后台任务的依据。

官网的40页可单独先发到Pages的`*.pages.dev`地址，但`/api/website-contact`
由`website/server/server.mjs`提供，纯静态部署无法提交咨询。正式对外前须
把同源咨询API接到受控常驻服务，配置SMTP、精确来源、边缘与源站限流，
并在已确认域名下重建canonical/sitemap和隐私联系信息；否则不能把咨询
页面描述成可收件。Pages直接上传预构建目录时，应只上传`website/dist/`，
不包含客户应用的`frontend/dist/`、后台、源码或私有配置。

若用Cloudflare Tunnel承载`app.<域名>`，只能使用关联自有域名的命名Tunnel
与常驻主机；随机`trycloudflare.com` Quick Tunnel只供测试，不能作为固定
客户入口。运营后台应在边缘限制`/admin.html`及`/api/platform/`，源站也要
验证Access令牌或采用仅可信代理可到达的私有入口，并保留应用内MFA。
现有`deploy/nginx/cloud.conf.template`按源地址做allowlist；直接放在
Cloudflare代理后看到的是代理地址，不能把现有规则当成已完成的访客IP控制。
部署前须选定并验证边缘Access/源站令牌或可信代理IP恢复方案，连同
`/api/platform/`完整路径一起实测拒绝与放行。禁止直接将5680/5681、
真实5638或试用5608暴露为Tunnel源站。

官网静态页已在 Cloudflare Pages 的 `shensi-ai-c4y.pages.dev` 临时地址发布；
这不包含客户产品、运营后台或咨询 API。目前仍没有确认的产品固定域名、
境外常驻主机、正式持久数据库、SMTP及管理员可用的Access身份，故产品与后台
部署仍是待落地方案，不是已经在线的服务。
这些信息到位后，先做官网静态与咨询分离验收，再在新空库初始化正式运营者；
本机合成账号及密钥不能复制到公网。阿里云切换遵守下方停写、空库恢复、
密文及授权核验和新写入差异处理，不以切换DNS代替数据迁移。

Cloudflare官方边界：[Pages限制](https://developers.cloudflare.com/pages/platform/limits/)、
[Pages预构建目录上传](https://developers.cloudflare.com/pages/get-started/direct-upload/)、
[Workers免费层限制](https://developers.cloudflare.com/workers/platform/limits/)、
[命名Tunnel前提](https://developers.cloudflare.com/tunnel/get-started/)、
[Quick Tunnel用途](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)、
[Access路径保护](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)及
[源站令牌校验](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)。

TLS配置参考[NGINX官方HTTPS配置](https://nginx.org/en/docs/http/configuring_https_servers.html)，
数据库容器实现参考[MySQL官方镜像源码](https://github.com/docker-library/mysql)。
沿用仓库既有软件与许可边界；上线镜像须扫描、验证目标架构并固定digest，
本地既有版本的语法检查不证明未来公网镜像安全或证书可信。

## 发布准备与配置检查

1. 从经过门禁的同一源码生成Backend和Frontend镜像。后端Dockerfile必须带齐
   平台生成合同。登记源码提交/工作区快照、镜像digest及测试包manifest SHA。
   仅把无密钥源码送入构建上下文；私有配置留在`.runtime`或仓库外。
2. 将`deploy/cloud.env.example`复制到仓库外的私有Compose配置，填已确认域名、
   三个镜像digest、TLS证书及私钥的绝对路径、运营网段文件、无冲突子网。
   默认443仅绑定127.0.0.1，完成审批、初始化与验收后才能改为公网绑定。
   证书必须匹配固定域名，设置续期与到期报警；更换证书后验证并reload gateway。
3. 私有Backend环境参考`.env.production.example`。使用外部新MySQL，
   `MYSQL_SSL_MODE=verify_ca`和服务商CA（实现同时检查主机名），保留所有独立长期密钥。
   `DATABASE_URL`不可指向真实桌面库；首次境外可命名`shensi_overseas`，
   后续工具恢复的目标空库命名`shensi`，符合现有迁移名称保护。
   禁止使用模板口令、真实客户API凭据或复制本机测试owner密钥。
4. 私有环境文件与TLS私钥权限收紧。容器运行用户必须能读取挂载文件；只给对应
   容器UID访问权，不能为了通过检查将私钥设为所有人可读。
5. `SHENSI_DESKTOP_CLIENT_ADMISSION_MODE=migration_locked`用于未交付阶段。
   经验证测试包/正式包使用`exact`及其实际manifest SHA；不得设通配准入。
   该控制不取代客户套餐校验，也不打开外联审批/执行。

```sh
node --env-file=/private/shensi/cloud.env scripts/cloud-deployment-check.mjs
docker compose --env-file /private/shensi/cloud.env -f deploy/compose.cloud.yaml config --quiet
```

静态检查不连接数据库、不校验证书信任或DNS，不拉取/运行镜像，也不会部署。
上线前另验证MySQL权限/TLS、schema初始化、健康检查、HTTPS证书、备份恢复和设备访问。
不可将`compose config`完整输出粘贴到工单，渲染结果可能含env_file密钥。

## 首个运营者初始化

在网络尚未开放的维护环境启动单API；Compose强制
`SHENSI_REQUIRE_PLATFORM_OWNER=true`，缺有效owner时客户注册返回503。
首个运营者必须是独立账号，不能使用legacy super_admin或普通客户账号。

仅在私有维护网络临时用`SHENSI_REQUIRE_PLATFORM_OWNER=false`启动API，
通过注册接口创建专属运营账号，安全记录返回的user ID；不允许此时公网注册。
随即停止API，用相同镜像/数据库/长期密钥执行离线初始化：
`node backend/dist/platform-admin-bootstrap.js`，私密注入
`SHENSI_PLATFORM_BOOTSTRAP_CONFIRM_DATABASE`、`SHENSI_PLATFORM_BOOTSTRAP_USER_ID`、
`SHENSI_PLATFORM_BOOTSTRAP_TOTP_SECRET`。CLI持有独占数据库API锁，拒绝重复owner。
恢复Compose强制门禁后重启，验证MFA再开放客户注册。密钥不写入命令参数、文档或日志。
配置例外应通过临时维护容器环境实现，不能提交关闭门禁的生产文件。

实际客户注册后只建立pending企业，运营后台按账号查到，明确配置已发布套餐和
起止时间后开通。授权变更撤销旧会话；客户刷新收到提示，重新登录获取最新权限。
不自动开通试用、不预置商业权益/天数/价格。试用/基础/专业只表示套餐类别。

## 备份与回退

- 正式库必须启用服务商自动快照/PITR及失败告警，在上线前确认保留期和恢复目标。
  每次发布/权限结构变更前做可识别快照，并定期恢复到另一空库验证，不能只检查
  备份文件存在。应用加密密钥与DB备份分开托管，否则密码可用也无法解密业务/MFA。
- 仓库`scripts/backup.mjs`与`restore.mjs`提供加密文件及认证清单，详见
  `../DATA_MIGRATION.md`。目前这些命令的数据库连接没有注入受管MySQL的CA/TLS配置，
  不能直接宣称适配任意远程云库；需目标适配验收，或先通过服务商原生安全快照恢复。
  不要通过关闭远程TLS规避此限制。Linux工具路径也须显式配置。
- 版本回退优先保留当前数据库，切回兼容该schema的上一组镜像及准入digest；
  先关闭新执行领取、保留在途回执，验证权限、MFA、客户读写和审计。
  不兼容schema不能仅回滚镜像；维护停写后恢复到新空库并核对schema清单、记录数、
  加密资料、tenant归属、账号与授权、历史任务/外部动作账本。
- 境外迁阿里云使用同版镜像和独立目标库，验证权限、字符集、时区、TLS及备份恢复。
  保留旧库；切流前停写和停领取。目标已有新写入时，不能直接切回旧库，必须先处理差异。
  已发送外部任务只对账，不因恢复或迁移重发。

## 发布验收与剩余外部依赖

按以下顺序留下可复核证据，任一步未通过都不进入正式V1.0安装包制作：

1. 新空库和固定HTTPS地址上线后，从另一网络的浏览器核验证书、健康接口、
   注册页、后台拒绝/放行、`/preview-access`不可达、数据库只在私网可达。
   源站不能绕过边缘Access访问运营API；浏览器产品API保持同源。
2. 先由正式运营者用独立MFA登录，发布经确认的试用/基础/专业套餐配置。
   用新客户账号注册，确认企业仅为pending，不能写业务；在后台按账号搜索，
   明确选套餐、席位和期限开通。保留操作日志和实际数据库记录证据，
   不在验收记录中保存密码、MFA种子、重置令牌或会话Cookie。
3. 客户旧会话应失效；重新登录后，用真实客户工作区保存并重读一条低风险
   业务记录，重启API后再次读取，核对租户归属。另建第二企业，验证不能
   读取或修改第一企业数据。验证到期只读、停用/恢复/续期和一次性改密。
   外联执行在此阶段保持关闭，不以发送外部私信/评论作为首发验收动作。
4. 将同一已验证API域名和**实际验收过的**安装包manifest digest配置到桌面
   准入，跨设备/网络完成包内注册、登录、授权后重新登录、核心业务保存和
   重开读取。后台与API镜像版本、数据库快照、客户端manifest及结果对应
   到同一验收批次；不能用5680本机合成测试或源码Electron替代正式环境验收。
5. 验证备份在另一空库可恢复，核对账号、授权、租户、加密资料和审计；
   确认监控/告警、证书续期、运营MFA恢复及可执行的回退步骤。全部通过后，
   产品任务才制作、签名、公证并在另一台设备验收V1.0正式安装包。

已有本机隔离测试覆盖注册、待开通、后台开通、旧会话重新登录、业务写入、
到期只读、停用/恢复/续期、跨企业拒绝和密码/MFA恢复；外网真实环境必须
重新逐项验收。
测试包须使用独立资料目录，不包含测试密码、owner密钥、旧用户数据或浏览器Profile。
本机测试包验收不等于正式签名/公证、其他设备/WAN、TLS域名或阿里云迁移验收。
外部依赖确定后再执行正式网络发布；当前配置文件的存在不代表服务已经公网在线。
