// Pure shared tokenization only; private ownership, cache and proof remain in retrieval.ts.
const stopWords = new Set(['你好', '您好', '谢谢', '你', '我', '我们', '请', '帮', '一下', '怎么', '如何', '什么', '是否', '的', '了', '吗', '做', '计划', '预测']);
let segmenter: Intl.Segmenter | undefined;
export function tokenize(text: string): string[] {
  segmenter ??= new Intl.Segmenter('zh-CN', { granularity: 'word' });
  const normalized = text.normalize('NFKC').toLowerCase()
    .replace(/应收账款回收|现金回款|货款回收|资金回笼|回款/gu, '现金流');
  return [...new Set([...segmenter.segment(normalized)].filter(s => s.isWordLike && !stopWords.has(s.segment)).map(s => s.segment))];
}
