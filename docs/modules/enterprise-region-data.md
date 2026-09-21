# 企业地区目录

省级目录34项；地级目录333项，包含地级市、地区、自治州和盟；32个省/自治区直辖县级单位以真实身份另列，不作为地级市。四个直辖市直接按本市选择，不造“市辖区/县”城市层。港澳台仅提供省级入口，不伪造目录未覆盖的下级。本功能不提供一般区县筛选。

主要来源为 [modood/Administrative-divisions-of-China](https://github.com/modood/Administrative-divisions-of-China)，固定commit `c49d495b40ac73eb1a66f6eeae5f8fd10696f035`，数据基准是2023-06-30、发布于2023-09-11的统计区划快照。该仓库明确不再更新，2025年Git提交不是2025年区划版本。界面标示2023年快照，不宣称当前全量最新。使用 `dist/provinces.json`、`cities.json`、`areas.json`，只保留本功能层级；台湾省71、香港81、澳门82省级代码名称另核对[交通运输部代码表](https://big5.mot.gov.cn/gate/big5/xxgk.mot.gov.cn/2020/jigou/zhghs/202006/P020241118605511168113.pdf)。这三个入口不附虚构城市。

复用许可为该固定版本的WTFPL-2.0，允许复制修改分发；无运行时第三方依赖，不执行仓库爬虫。对比 `uiwjs/province-city-china`（MIT）后，其README数据日期更早，未选作地级目录。上游许可保留在前端 `THIRD_PARTY_NOTICES.md`。

再生成：下载上述固定commit三个JSON，运行 `node scripts/import-enterprise-regions.mjs provinces.json cities.json areas.json`。生成器剔除直辖市虚拟统计汇总层，将直辖县级汇总组展开为真实条目，校验34省级/333地级及唯一代码，输出 `frontend/src/enterprise-query/region-data.ts`。

数据范围：完整目录用于选择条件，不代表拥有全国企业数据。已有资料只匹配明确地区名称、代码或省市完整路径；省级可包含明确城市，不从“中国”等笼统字段推断归属。GLEIF不接受此地区筛选。在线爱企查入口只携带显式名称或已选地区/行业组成的关键词；需在网站进一步选择精确条件，不伪造上游地区行业API。
