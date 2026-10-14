# 企业行业分类数据

使用国家统计局发布的《2017国民经济行业分类注释》（按第1号修改单修订），GB/T 4754-2017，2019年修改单版本。2026-09-15核对[官方分类目录](https://www.stats.gov.cn/sj/tjbz/gmjjhyfl/)。分类包括20门类、97大类、473中类、1382小类，共1972节点。

事实来源：[官方发布页](https://www.stats.gov.cn/sj/tjbz/gmjjhyfl/202302/t20230213_1902780.html)，[原始XLSX](https://www.stats.gov.cn/sj/tjbz/gmjjhyfl/202302/P020230213403084213497.xlsx)。仅提取分类代码、名称、父级关系，不复制分类解释、例举及整份标准。官方资料不是附带开源软件许可证的代码包，不将其标记为MIT或CC0。

复用评估：`ramwin/china-public-data`为GPL-3.0；`crapthings/industrial-classification`和`Hyhyhyhyhyhyh/CN_industry_code_2017`未发现许可证；`SageZhang/china_public_data_json`虽为Apache-2.0，但2017年旧快照不满足当前四级修订数据要求。没有将上述仓库的数据或代码复制入产品。

再生成：下载上述XLSX到临时目录，运行 `python3 scripts/import-enterprise-industry.py /path/to/source.xlsx`。脚本仅使用Python标准库，读取首张表A/B代码列与D名称列，校验各层数量、代码唯一性、父级完整性，生成 `frontend/src/enterprise-query/industry-data.ts`。不需要运行时依赖或联网拉分类。

选择器支持名称/代码搜索与门类→大类→中类→小类级联，显示完整路径，选上级包含下级。筛选只适用于已加载企业资料中明确给出的分类名称或代码；缺失/无法对应的业务描述不猜测归类，可用关键词检索。地区目录和匹配范围见[地区数据](enterprise-region-data.md)。GLEIF仅支持名称查询，因此该源隐藏地区/行业/规模，不发送或忽略这些条件。爱企查当前页读取预览独立于已有资料筛选，在线入口仅传关键词，不声称可以直接操纵网站的精确行业过滤。

验证：`pnpm --dir frontend exec tsx --test src/enterprise-query/industry.test.ts src/enterprise-query/filters.test.ts src/enterprise-query/model.test.ts`。
