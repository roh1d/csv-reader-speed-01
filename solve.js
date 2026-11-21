// A faster drop-in for csv-reader 1.0.0: run(input) returns csv-reader's reading of {text, header}, the JSON value
// {columns, rows, errors}, exactly as the reference does, in one left-to-right pass with no per-character strings.
//
// The reference walks the text one character at a time and builds every field by `value += c`. This reads the same
// text the same way but scans with charCodeAt and cuts each field out of the text with slice, assembling a field from
// pieces only where a character has to be rewritten ("" to ", CRLF or a lone CR inside quotes to LF) or dropped (a
// stray CR outside quotes). Those cases are rare, so they live in cold helpers.
//
// The policy, unchanged from csv-reader 1.0.0:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside it one quote, and each CRLF
//     or lone CR inside it is read as LF; what follows its closing quote, up to the next comma or line break, is
//     appended to it as it stands (quote_junk, when the field ends); a quote that never closes is read as a literal
//     character and the text after it is read again as an unquoted field (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the records after it (every record when
//     header is false), each padded with "" (short_row, with fields: its count) or cut (long_row, with extra: the cut
//     fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on (every LF, CRLF and lone CR inside a
//     quoted field counted), row its record's index in rows (null for the header), in the order met, a field's
//     quote_junk when the field ends and a record's short_row or long_row when the record ends.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

/** A field ended at a comma: the record goes on. */
const COMMA = 0;
/** A field ended at a line break: the record ends. */
const LINE_BREAK = 1;
/** A field ended at the end of the text: the record ends. */
const END = 2;

const QUOTE = 34;
const COMMA_CHAR = 44;
const LF = 10;
const CR = 13;

/**
 * Reads unquoted characters onto `prefix` from `start` up to the next comma or line break, dropping a CR not followed
 * by LF (stray_cr). Cold: the junk after a closing quote and the replay after an unterminated quote.
 * `added` counts the characters kept past the prefix, which is what tells quote_junk from an empty tail.
 */
function readUnquotedFrom(text, n, start, prefix, errors, recordLine, recordRow) {
  let p = start;
  let vstart = p;
  let parts = null;
  let added = 0;
  let ended = END;
  let lineInc = 0;
  while (p < n) {
    const c = text.charCodeAt(p);
    if (c === COMMA_CHAR) {
      ended = COMMA;
      break;
    }
    if (c === LF) {
      ended = LINE_BREAK;
      lineInc = 1;
      break;
    }
    if (c === CR) {
      if (p + 1 < n && text.charCodeAt(p + 1) === LF) {
        ended = LINE_BREAK;
        lineInc = 1;
        break;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (parts === null) parts = [];
      const seg = text.slice(vstart, p);
      parts.push(seg);
      added += seg.length;
      p += 1;
      vstart = p;
      continue;
    }
    p += 1;
  }
  const seg = text.slice(vstart, p);
  added += seg.length;
  let value;
  if (parts === null) {
    value = prefix + seg;
  } else {
    parts.push(seg);
    value = prefix + parts.join('');
  }
  let pos;
  if (ended === COMMA) pos = p + 1;
  else if (ended === LINE_BREAK) pos = text.charCodeAt(p) === LF ? p + 1 : p + 2;
  else pos = p;
  return { value, ended, pos, lineInc, added };
}

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;

  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  for (;;) {
    // A line left with no characters is no record: skip LF and CRLF runs.
    for (;;) {
      if (pos >= n) break;
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && pos + 1 < n && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    const fields = [];
    let lastQuoted = false;
    let ended = COMMA;
    for (;;) {
      if (pos >= n) {
        // Only after a trailing comma: the reference reads one more empty field ending at the end of the text.
        lastQuoted = false;
        fields.push('');
        ended = END;
        break;
      }

      const c0 = text.charCodeAt(pos);
      if (c0 === QUOTE) {
        lastQuoted = true;
        const openLine = line;
        let p = pos + 1;
        let vstart = p;
        let parts = null;
        let closed = false;
        while (p < n) {
          const c = text.charCodeAt(p);
          if (c === QUOTE) {
            if (p + 1 < n && text.charCodeAt(p + 1) === QUOTE) {
              if (parts === null) parts = [];
              parts.push(text.slice(vstart, p), '"');
              p += 2;
              vstart = p;
              continue;
            }
            closed = true;
            break;
          }
          if (c === CR) {
            // CRLF and a lone CR inside quotes are each one LF.
            if (parts === null) parts = [];
            parts.push(text.slice(vstart, p), '\n');
            line += 1;
            p += p + 1 < n && text.charCodeAt(p + 1) === LF ? 2 : 1;
            vstart = p;
            continue;
          }
          if (c === LF) line += 1;
          p += 1;
        }

        if (!closed) {
          // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
          pos = pos + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          const r = readUnquotedFrom(text, n, pos, '"', errors, recordLine, recordRow);
          fields.push(r.value);
          pos = r.pos;
          line += r.lineInc;
          ended = r.ended;
          if (ended !== COMMA) break;
          continue;
        }

        const value = parts === null ? text.slice(vstart, p) : (parts.push(text.slice(vstart, p)), parts.join(''));
        pos = p + 1;
        if (pos >= n) {
          fields.push(value);
          ended = END;
          break;
        }
        const d = text.charCodeAt(pos);
        if (d === COMMA_CHAR) {
          pos += 1;
          fields.push(value);
          ended = COMMA;
          continue;
        }
        if (d === LF) {
          pos += 1;
          line += 1;
          fields.push(value);
          ended = LINE_BREAK;
          break;
        }
        if (d === CR && pos + 1 < n && text.charCodeAt(pos + 1) === LF) {
          pos += 2;
          line += 1;
          fields.push(value);
          ended = LINE_BREAK;
          break;
        }
        // What follows the closing quote is appended as it stands, up to the next comma or line break.
        const junk = readUnquotedFrom(text, n, pos, value, errors, recordLine, recordRow);
        if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        fields.push(junk.value);
        pos = junk.pos;
        line += junk.lineInc;
        ended = junk.ended;
        if (ended !== COMMA) break;
        continue;
      }

      // Unquoted: runs to the next comma or line break, a stray CR dropped as it stands.
      lastQuoted = false;
      let p = pos;
      let vstart = p;
      let parts = null;
      let kind = END;
      while (p < n) {
        const c = text.charCodeAt(p);
        if (c === COMMA_CHAR) {
          kind = COMMA;
          break;
        }
        if (c === LF) {
          kind = LINE_BREAK;
          break;
        }
        if (c === CR) {
          if (p + 1 < n && text.charCodeAt(p + 1) === LF) {
            kind = LINE_BREAK;
            break;
          }
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          if (parts === null) parts = [];
          parts.push(text.slice(vstart, p));
          p += 1;
          vstart = p;
          continue;
        }
        p += 1;
      }
      const value = parts === null ? text.slice(vstart, p) : (parts.push(text.slice(vstart, p)), parts.join(''));
      fields.push(value);
      if (kind === COMMA) {
        pos = p + 1;
        ended = COMMA;
        continue;
      }
      if (kind === LINE_BREAK) {
        if (text.charCodeAt(p) === LF) pos = p + 1;
        else pos = p + 2;
        line += 1;
        ended = LINE_BREAK;
        break;
      }
      pos = p;
      ended = END;
      break;
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    const len = fields.length;
    if (len < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: len });
      while (fields.length < width) fields.push('');
    } else if (len > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
