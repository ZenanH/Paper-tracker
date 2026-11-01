export function paperTitle(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/\p{L}/u, letter => letter.toLocaleUpperCase('en-US'));
}
