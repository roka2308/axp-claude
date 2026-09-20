import type { ReactNode } from 'react';
import styles from './DataTable.module.css';

export interface DataTableColumn {
  readonly key: string;
  readonly label: string;
  readonly numeric?: boolean;
}

export interface DataTableRow {
  readonly key: string;
  readonly cells: Readonly<Record<string, ReactNode>>;
}

export interface DataTableProps {
  readonly columns: readonly DataTableColumn[];
  readonly rows: readonly DataTableRow[];
  /** Accessible description of the table's purpose. */
  readonly caption: string;
  /** Hides the caption visually while keeping it for assistive technology. */
  readonly captionHidden?: boolean;
  readonly emptyLabel?: string;
}

/**
 * Accessible data table.
 *
 * Real table semantics with a caption and row headers, because an accessible
 * table is an MVP requirement and because this is also the data alternative
 * that every chart needs (D10).
 */
export function DataTable({
  columns,
  rows,
  caption,
  captionHidden = false,
  emptyLabel,
}: DataTableProps) {
  if (rows.length === 0 && emptyLabel) {
    return <p className={styles.empty}>{emptyLabel}</p>;
  }

  return (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <caption className={captionHidden ? 'axp-visually-hidden' : undefined}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={column.numeric ? styles.numeric : undefined}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              {columns.map((column, index) => {
                const content = row.cells[column.key];
                // The first column is the row's label, so it is its header.
                return index === 0 ? (
                  <th key={column.key} scope="row">
                    {content}
                  </th>
                ) : (
                  <td key={column.key} className={column.numeric ? styles.numeric : undefined}>
                    {content}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
