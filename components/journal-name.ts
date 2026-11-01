const minorWords = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'onto', 'or', 'over', 'per', 'the', 'to', 'via', 'with']);

export function journalName(value: string): string {
  const allUppercase = value === value.toLocaleUpperCase('en-US');
  let firstWord = true;
  return value.replace(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu, (word, offset: number) => {
    const lower = word.toLocaleLowerCase('en-US');
    const afterColon = value.slice(0, offset).trimEnd().endsWith(':');
    const acronym = !allUppercase && !minorWords.has(lower) && word.length > 1 && word.length <= 6 && word === word.toLocaleUpperCase('en-US');
    const formatted = acronym
      ? word
      : minorWords.has(lower) && !firstWord && !afterColon
        ? lower
        : lower[0].toLocaleUpperCase('en-US') + lower.slice(1);
    firstWord = false;
    return formatted;
  });
}
