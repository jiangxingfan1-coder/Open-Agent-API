// 截图用的演示文字：智能体说明、任务输入、密钥名、任务输出。两种语言是同一套演示数据（同样的智能体、
// 同样的任务、同样的数字），只有示例文字不同；英文版里不出现中文内容。
// 浏览器里的假网关（console-harness.js、portal-harness.js）读 window.__SHOT.text，数字与结构在那里，文字在这里。
export const TEXTS = {
  zh: {
    agents: {
      'agent/research': '资料研究与综合分析：检索、交叉验证并给出带出处的结论',
      'agent/writer': '长文写作与润色',
      'agent/coder': '读代码、改代码并运行测试，改动前等你批准',
      'agent/reviewer': '代码评审：逐个文件给出问题与建议',
      'agent/translate': '多语种翻译',
      'agent/finance-recon': '季度对账与差异分析：核对各子公司往来并生成差异表',
      'agent/sql': '根据表结构生成并检查数据库迁移脚本',
    },
    skills: {
      research: ['引用格式'],
      writer: ['中文润色', '标题生成'],
      reviewer: ['评审清单'],
      translate: ['术语表'],
    },
    runs: {
      coder_login: '把登录页的报错提示改成中文，并补一个单元测试，确保空密码时也能给出提示',
      research_pricing: '调研 2026 年企业级智能体平台的定价方式',
      reviewer_orders: '评审订单模块的重构方案',
      writer_board: '把这份季度复盘写成面向董事会的一页纸摘要，语气克制，数字准确',
      translate_notes: '把 0.6 版发布说明翻译成简体中文，保留代码块与链接',
      research_quotes: '整理三家供应商的报价单，比较交付周期与总价',
      research_feedback: '汇总上周的客户反馈，按主题归类并标出需要跟进的条目',
      coder_ci: '修复 CI 中偶发失败的测试',
      finance_q3: '核对第三季度各子公司的应收应付差异，并生成差异分析表',
      sql_paid_at: '为 orders 表增加 paid_at 字段并回填历史数据',
      research_compare: '对比两款同类产品的接入成本与限制，给出选型建议',
      translate_contract: '翻译采购合同第 3 章，术语以术语表为准',
      coder_pagination: '为列表接口增加分页参数，并补充接口文档',
    },
    keys: {
      prod: '生产环境 · 客服机器人',
      long: '数据组临时试用（一个特别长的密钥名称用来检查换行是否正常）',
    },
    outputCoder:
      '已定位到登录页的报错文案：src/pages/login.ts 里的 3 处英文提示。\n\n已完成\n- 把「Invalid credentials」等提示改成中文，并抽到 src/i18n/zh.ts\n- 新增 src/auth/login.test.ts，覆盖空密码、错误密码两种情况\n\n下一步\n- 运行 npm test -- --run auth 确认测试通过（等待你批准执行）\n- 通过后再把 login.ts 的改动写入文件（等待你批准写入）\n',
    portalAgents: [
      [
        'agent/research',
        '研究助手',
        '检索、交叉验证并给出带出处的结论',
        { per_run: 0.5, per_1k_tokens: 0.02 },
      ],
      ['agent/coder', '代码助手', '读代码、改代码并运行测试，改动前等你批准', { per_run: 2 }],
      ['agent/writer', '写作助手', '长文写作与润色', { per_run: 0.3 }],
      ['agent/translate', '翻译助手', '多语种翻译，支持术语表', {}],
    ],
  },
  en: {
    agents: {
      'agent/research': 'Source-grounded research: search, cross-check, and answer with citations',
      'agent/writer': 'Long-form writing and polishing',
      'agent/coder':
        'Reads and edits code, runs tests, and waits for your approval before changing anything',
      'agent/reviewer': 'Code review: issues and suggestions, file by file',
      'agent/translate': 'Multilingual translation',
      'agent/finance-recon': 'Quarterly reconciliation and variance analysis across subsidiaries',
      'agent/sql': 'Generates and checks database migration scripts from a table schema',
    },
    skills: {
      research: ['Citation style'],
      writer: ['Copy polish', 'Headline ideas'],
      reviewer: ['Review checklist'],
      translate: ['Glossary'],
    },
    runs: {
      coder_login:
        'Rewrite the login page error messages in plain language and add a unit test, so an empty password also gets a hint',
      research_pricing: 'Research how enterprise agent platforms price their products in 2026',
      reviewer_orders: 'Review the refactoring plan for the orders module',
      writer_board:
        'Turn this quarterly review into a one-page board summary: restrained tone, accurate numbers',
      translate_notes:
        'Translate the 0.6 release notes into Spanish, keeping code blocks and links',
      research_quotes: 'Compare three suppliers’ quotes on lead time and total price',
      research_feedback:
        'Summarize last week’s customer feedback by theme and flag the items that need follow-up',
      coder_ci: 'Fix the flaky test in CI',
      finance_q3:
        'Reconcile Q3 receivables and payables across subsidiaries and produce a variance table',
      sql_paid_at: 'Add a paid_at column to the orders table and backfill historical data',
      research_compare:
        'Compare the integration cost and limits of two similar products and recommend one',
      translate_contract: 'Translate chapter 3 of the purchase contract, following the glossary',
      coder_pagination: 'Add pagination parameters to the list endpoint and update the API docs',
    },
    keys: {
      prod: 'Production · support bot',
      long: 'Data team trial (an unusually long key name to check that it wraps)',
    },
    outputCoder:
      'Found the error messages on the login page: 3 terse strings in src/pages/login.ts.\n\nDone\n- Rewrote messages such as “Invalid credentials” in plain language and moved them to src/i18n/en.ts\n- Added src/auth/login.test.ts, covering an empty password and a wrong password\n\nNext\n- Run npm test -- --run auth to confirm the tests pass (waiting for your approval to run)\n- Then write the login.ts changes to disk (waiting for your approval to write)\n',
    portalAgents: [
      [
        'agent/research',
        'Research assistant',
        'Searches, cross-checks, and answers with citations',
        { per_run: 0.5, per_1k_tokens: 0.02 },
      ],
      [
        'agent/coder',
        'Code assistant',
        'Reads and edits code, runs tests, and waits for your approval before changing anything',
        { per_run: 2 },
      ],
      ['agent/writer', 'Writing assistant', 'Long-form writing and polishing', { per_run: 0.3 }],
      [
        'agent/translate',
        'Translation assistant',
        'Multilingual translation with glossary support',
        {},
      ],
    ],
  },
};
