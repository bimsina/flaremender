import { Button, Pagination, Table as KumoTable, Text, cn } from '@cloudflare/kumo'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowsDownUpIcon,
  MagnifyingGlassIcon,
} from '@phosphor-icons/react'
import { useState } from 'react'

function TableRoot({
  label,
  toolbar,
  footer,
  className,
  ...props
}: React.ComponentProps<typeof KumoTable> & {
  label: string
  toolbar?: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line">
      {toolbar ? <div className="border-b border-kumo-line p-3 sm:px-4">{toolbar}</div> : null}
      <div
        className="table-scroll overflow-x-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-kumo-focus"
        role="region"
        aria-label={`${label}, scroll to see more columns`}
        tabIndex={0}
      >
        <KumoTable {...props} aria-label={label} className={cn('data-table', className)} />
      </div>
      {footer ? <div className="border-t border-kumo-line px-4 py-3">{footer}</div> : null}
    </div>
  )
}

function TableHead(props: React.ComponentProps<typeof KumoTable.Head>) {
  const headProps: React.ThHTMLAttributes<HTMLTableCellElement> = { scope: 'col', ...props }
  return <KumoTable.Head {...headProps} />
}

function SortHead({
  children,
  direction,
  onSort,
  className,
}: {
  children: string
  direction?: 'asc' | 'desc'
  onSort: () => void
  className?: string
}) {
  const Icon =
    direction === 'asc' ? ArrowUpIcon : direction === 'desc' ? ArrowDownIcon : ArrowsDownUpIcon
  return (
    <TableHead
      className={className}
      aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}
    >
      <button
        type="button"
        onClick={onSort}
        className="inline-flex items-center gap-1.5 rounded-sm text-left hover:text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-focus"
        aria-label={`Sort by ${children.toLowerCase()}`}
      >
        {children}
        <Icon size={14} className={direction ? 'text-kumo-default' : 'text-kumo-inactive'} />
      </button>
    </TableHead>
  )
}

function TableEmpty({
  columns,
  message = 'No results found',
  onClear,
}: {
  columns: number
  message?: string
  onClear?: () => void
}) {
  return (
    <KumoTable.Row>
      <KumoTable.Cell colSpan={columns}>
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <MagnifyingGlassIcon size={24} className="text-kumo-subtle" />
          <Text bold>{message}</Text>
          {onClear ? (
            <Button variant="secondary" size="sm" onClick={onClear}>
              Clear filters
            </Button>
          ) : null}
        </div>
      </KumoTable.Cell>
    </KumoTable.Row>
  )
}

export const Table = Object.assign(TableRoot, {
  Header: KumoTable.Header,
  Head: TableHead,
  SortHead,
  Body: KumoTable.Body,
  Row: KumoTable.Row,
  Cell: KumoTable.Cell,
  Empty: TableEmpty,
})

// Keep pagination local to the loaded results. A changed search or filter starts at page one.
export function useTablePagination<T>(rows: readonly T[], resetKey = '') {
  const [state, setState] = useState({ page: 1, perPage: 10, key: resetKey })
  if (state.key !== resetKey) {
    setState({ ...state, page: 1, key: resetKey })
  }
  const page = Math.min(
    state.key === resetKey ? state.page : 1,
    Math.max(1, Math.ceil(rows.length / state.perPage)),
  )
  return {
    items: rows.slice((page - 1) * state.perPage, page * state.perPage),
    page,
    perPage: state.perPage,
    totalCount: rows.length,
    setPage: (next: number) => setState({ ...state, key: resetKey, page: next }),
    setPerPage: (next: number) => setState({ page: 1, perPage: next, key: resetKey }),
  }
}

export function TablePagination({
  page,
  perPage,
  totalCount,
  setPage,
  setPerPage,
}: {
  page: number
  perPage: number
  totalCount: number
  setPage: (page: number) => void
  setPerPage: (perPage: number) => void
}) {
  return (
    <Pagination
      page={page}
      setPage={setPage}
      perPage={perPage}
      totalCount={totalCount}
      className="flex flex-wrap items-center justify-between gap-3"
    >
      <Pagination.Info className="text-base text-kumo-subtle">
        {({ pageShowingRange }) =>
          totalCount === 0
            ? '0 results'
            : totalCount <= perPage
              ? `${totalCount} result${totalCount === 1 ? '' : 's'}`
              : `${pageShowingRange} of ${totalCount} results`
        }
      </Pagination.Info>
      {totalCount > 10 ? (
        <div className="flex flex-wrap items-center gap-4">
          <Pagination.PageSize
            value={perPage}
            onChange={setPerPage}
            options={[10, 25, 50]}
            label="Rows per page"
          />
          <Pagination.Controls controls="simple" />
        </div>
      ) : null}
    </Pagination>
  )
}
