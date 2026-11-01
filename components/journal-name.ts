const minorWords = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'onto', 'or', 'over', 'per', 'the', 'to', 'via', 'with']);
const canonicalAcronyms = new Set([
  'aaai', 'aaas', 'acm', 'acs', 'aiaa', 'aids', 'aims', 'aip', 'ai', 'apl', 'aps', 'asce', 'asme', 'awwa',
  'bmj', 'bmc', 'cabi', 'ccf', 'dna', 'epj', 'esaim', 'esmo', 'febs', 'hiv', 'ieee', 'ieej', 'ieice', 'iet',
  'iium', 'iise', 'iop', 'it', 'jama', 'jacc', 'jbi', 'jbjs', 'jcms', 'jco', 'jmir', 'jnci', 'lgbt', 'lgbtq', 'mmwr', 'mrs',
  'nasa', 'nar', 'nist', 'plos', 'rsc', 'rna', 'sae', 'sage', 'siam', 'spie', 'stem', 'who',
]);

export function journalName(value: string): string {
  const allUppercase = value === value.toLocaleUpperCase('en-US');
  let firstWord = true;
  return value.replace(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu, (word, offset: number) => {
    const lower = word.toLocaleLowerCase('en-US');
    const afterColon = value.slice(0, offset).trimEnd().endsWith(':');
    const canonicalAcronym = canonicalAcronyms.has(lower);
    const sourceAcronym = !allUppercase && !minorWords.has(lower) && word.length > 1 && word.length <= 6 && word === word.toLocaleUpperCase('en-US');
    let formatted = lower[0].toLocaleUpperCase('en-US') + lower.slice(1);
    if (canonicalAcronym) formatted = lower.toLocaleUpperCase('en-US');
    else if (sourceAcronym) formatted = word;
    else if (minorWords.has(lower) && !firstWord && !afterColon) formatted = lower;
    firstWord = false;
    return formatted;
  });
}
