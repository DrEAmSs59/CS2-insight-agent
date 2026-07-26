"""Small, dependency-free column table used by the demo parser pipeline.

This module intentionally implements only the dataframe operations used by the
application.  It keeps parser data columnar without importing pandas or numpy,
which saves roughly half of the packaged Python runtime.
"""

from __future__ import annotations

from collections import OrderedDict, deque
from collections.abc import Iterable, Mapping, Sequence
from typing import Any, Callable, Iterator


class _Missing:
    def __repr__(self) -> str:
        return "NA"

    def __bool__(self) -> bool:
        return False


NA = _Missing()
__version__ = "native-1"


def isna(value: Any) -> bool:
    if value is None or value is NA:
        return True
    try:
        result = value != value
        return bool(result) if isinstance(result, bool) else False
    except Exception:
        return False


def notna(value: Any) -> bool:
    return not isna(value)


class Row(dict):
    @property
    def index(self) -> list[str]:
        return list(self.keys())


class _ValuesList(list):
    def tolist(self) -> list[Any]:
        return list(self)


class _StringMethods:
    def __init__(self, series: "Series") -> None:
        self._series = series

    def strip(self) -> "Series":
        return Series(
            [value.strip() if isinstance(value, str) else value for value in self._series],
            index=self._series.index,
            name=self._series.name,
        )

    def lower(self) -> "Series":
        return Series(
            [value.lower() if isinstance(value, str) else value for value in self._series],
            index=self._series.index,
            name=self._series.name,
        )


class _SeriesILoc:
    def __init__(self, series: "Series") -> None:
        self._series = series

    def __getitem__(self, key: int | slice | Sequence[int]) -> Any:
        if isinstance(key, int):
            return self._series._values[key]
        positions = list(range(len(self._series)))[key] if isinstance(key, slice) else list(key)
        return Series(
            [self._series._values[pos] for pos in positions],
            index=[self._series.index[pos] for pos in positions],
            name=self._series.name,
        )


class Series:
    def __init__(
        self,
        data: Any = None,
        index: Sequence[Any] | None = None,
        name: str | None = None,
    ) -> None:
        if isinstance(data, Series):
            values = list(data._values)
            default_index = list(data.index)
            if name is None:
                name = data.name
        elif isinstance(data, Mapping):
            default_index = list(data.keys())
            values = list(data.values())
        elif data is None:
            values = [] if index is None else [None] * len(index)
            default_index = list(range(len(values)))
        elif isinstance(data, (str, bytes, bytearray)) or not isinstance(data, Iterable):
            values = [data] if index is None else [data] * len(index)
            default_index = list(range(len(values)))
        else:
            values = list(data)
            default_index = list(range(len(values)))
        self._values = values
        self.index = list(index) if index is not None else default_index
        if len(self.index) != len(self._values):
            raise ValueError("Series data and index must have the same length")
        self.name = name

    def __len__(self) -> int:
        return len(self._values)

    def __iter__(self) -> Iterator[Any]:
        return iter(self._values)

    def __getitem__(self, key: Any) -> Any:
        if isinstance(key, slice):
            return Series(self._values[key], index=self.index[key], name=self.name)
        if isinstance(key, int) and key not in self.index:
            return self._values[key]
        try:
            position = self.index.index(key)
        except ValueError:
            if isinstance(key, int):
                return self._values[key]
            raise KeyError(key) from None
        return self._values[position]

    def __repr__(self) -> str:
        return f"Series({self._values!r})"

    @property
    def iloc(self) -> _SeriesILoc:
        return _SeriesILoc(self)

    @property
    def str(self) -> _StringMethods:
        return _StringMethods(self)

    @property
    def dtype(self) -> str:
        return _infer_dtype(self._values)

    def get(self, key: Any, default: Any = None) -> Any:
        try:
            return self[key]
        except (KeyError, IndexError):
            return default

    def tolist(self) -> list[Any]:
        return list(self._values)

    to_list = tolist

    def copy(self) -> "Series":
        return Series(self, name=self.name)

    def head(self, count: int = 5) -> "Series":
        return self.iloc[: max(0, int(count))]

    def to_dict(self) -> dict[Any, Any]:
        return dict(zip(self.index, self._values))

    def items(self) -> Iterator[tuple[Any, Any]]:
        return iter(zip(self.index, self._values))

    def _binary(self, other: Any, operation: Callable[[Any, Any], Any]) -> "Series":
        if isinstance(other, Series):
            if len(other) != len(self):
                raise ValueError("Series operands must have the same length")
            right = other._values
        else:
            right = [other] * len(self)
        values = []
        for left_value, right_value in zip(self._values, right):
            try:
                values.append(operation(left_value, right_value))
            except (TypeError, ValueError, OverflowError):
                values.append(False)
        return Series(values, index=self.index, name=self.name)

    def __eq__(self, other: Any) -> "Series":
        return self._binary(other, lambda left, right: left == right)

    def __ne__(self, other: Any) -> "Series":
        return self._binary(other, lambda left, right: left != right)

    def __lt__(self, other: Any) -> "Series":
        return self._binary(other, lambda left, right: left < right)

    def __le__(self, other: Any) -> "Series":
        return self._binary(other, lambda left, right: left <= right)

    def __gt__(self, other: Any) -> "Series":
        return self._binary(other, lambda left, right: left > right)

    def __ge__(self, other: Any) -> "Series":
        return self._binary(other, lambda left, right: left >= right)

    def __and__(self, other: Any) -> "Series":
        return self._binary(other, lambda left, right: bool(left) and bool(right))

    def __or__(self, other: Any) -> "Series":
        return self._binary(other, lambda left, right: bool(left) or bool(right))

    def __invert__(self) -> "Series":
        return Series([not bool(value) for value in self], index=self.index, name=self.name)

    def __iand__(self, other: Any) -> "Series":
        result = self & other
        self._values = result._values
        return self

    def __ior__(self, other: Any) -> "Series":
        result = self | other
        self._values = result._values
        return self

    def astype(self, dtype: Any) -> "Series":
        converter: Callable[[Any], Any]
        if dtype in (str, "str", "string"):
            converter = str
        elif dtype in (int, "int", "int64"):
            converter = int
        elif dtype in (float, "float", "float64"):
            converter = float
        elif dtype in (bool, "bool"):
            converter = bool
        elif callable(dtype):
            converter = dtype
        else:
            raise TypeError(f"Unsupported dtype: {dtype!r}")
        values = []
        for value in self:
            if isna(value):
                values.append(value)
            else:
                values.append(converter(value))
        return Series(values, index=self.index, name=self.name)

    def fillna(self, value: Any) -> "Series":
        if isinstance(value, Series):
            replacements = value._values
        else:
            replacements = [value] * len(self)
        return Series(
            [replacement if isna(current) else current for current, replacement in zip(self, replacements)],
            index=self.index,
            name=self.name,
        )

    def where(self, condition: Any, other: Any = None) -> "Series":
        mask = condition._values if isinstance(condition, Series) else list(condition)
        replacements = other._values if isinstance(other, Series) else [other] * len(self)
        return Series(
            [current if bool(keep) else replacement for current, keep, replacement in zip(self, mask, replacements)],
            index=self.index,
            name=self.name,
        )

    def isin(self, values: Iterable[Any]) -> "Series":
        candidates = set(values)
        return Series([value in candidates for value in self], index=self.index, name=self.name)

    def dropna(self) -> "Series":
        keep = [(idx, value) for idx, value in zip(self.index, self) if not isna(value)]
        return Series([value for _, value in keep], index=[idx for idx, _ in keep], name=self.name)

    def isna(self) -> "Series":
        return Series([isna(value) for value in self], index=self.index, name=self.name)

    def notna(self) -> "Series":
        return Series([notna(value) for value in self], index=self.index, name=self.name)

    def unique(self) -> _ValuesList:
        result: _ValuesList = _ValuesList()
        for value in self:
            if value not in result:
                result.append(value)
        return result

    def min(self) -> Any:
        values = [value for value in self if not isna(value)]
        return min(values) if values else float("nan")

    def max(self) -> Any:
        values = [value for value in self if not isna(value)]
        return max(values) if values else float("nan")

    def sum(self) -> Any:
        return sum(value for value in self if not isna(value))

    def mean(self) -> float:
        values = [float(value) for value in self if not isna(value)]
        return sum(values) / len(values) if values else float("nan")

    def value_counts(self) -> "Series":
        counts: OrderedDict[Any, int] = OrderedDict()
        for value in self:
            if not isna(value):
                counts[value] = counts.get(value, 0) + 1
        ordered = sorted(counts.items(), key=lambda item: item[1], reverse=True)
        return Series([count for _, count in ordered], index=[value for value, _ in ordered])

    def any(self) -> bool:
        return any(bool(value) for value in self)

    def all(self) -> bool:
        return all(bool(value) for value in self)

    def shift(self, periods: int = 1) -> "Series":
        count = int(periods)
        if count >= 0:
            values = [None] * count + self._values[: max(0, len(self) - count)]
        else:
            offset = -count
            values = self._values[offset:] + [None] * min(offset, len(self))
        return Series(values[: len(self)], index=self.index, name=self.name)

    def sub(self, other: Any) -> "Series":
        return self._binary(other, lambda left, right: left - right)

    def pow(self, exponent: float) -> "Series":
        return Series(
            [value if isna(value) else value ** exponent for value in self],
            index=self.index,
            name=self.name,
        )

    def gt(self, other: Any) -> "Series":
        return self > other

    def ne(self, other: Any) -> "Series":
        return self != other

    def cumsum(self) -> "Series":
        total = 0
        values = []
        for value in self:
            if isna(value):
                values.append(None)
            else:
                total += value
                values.append(total)
        return Series(values, index=self.index, name=self.name)

    def diff(self, periods: int = 1) -> "Series":
        return self.sub(self.shift(periods))

    def apply(self, function: Callable[[Any], Any]) -> "Series":
        return Series([function(value) for value in self], index=self.index, name=self.name)


class _ILocIndexer:
    def __init__(self, frame: "DataFrame") -> None:
        self._frame = frame

    def __getitem__(self, key: int | slice | Sequence[int]) -> Any:
        if isinstance(key, int):
            position = key if key >= 0 else len(self._frame) + key
            return self._frame._row_at(position)
        positions = list(range(len(self._frame)))[key] if isinstance(key, slice) else list(key)
        return self._frame._take_positions(positions)


class _LocIndexer:
    def __init__(self, frame: "DataFrame") -> None:
        self._frame = frame

    def __getitem__(self, key: Any) -> Any:
        if isinstance(key, tuple):
            row_key, column_key = key
            selected = self._select_rows(row_key)
            return selected[column_key]
        return self._select_rows(key)

    def _select_rows(self, key: Any) -> "DataFrame":
        if isinstance(key, Series):
            return self._frame._take_positions([pos for pos, value in enumerate(key) if bool(value)])
        if isinstance(key, Sequence) and not isinstance(key, (str, bytes, bytearray)):
            key_values = list(key)
            if all(isinstance(value, bool) for value in key_values):
                return self._frame._take_positions([pos for pos, value in enumerate(key_values) if value])
            wanted = set(key_values)
            return self._frame._take_positions(
                [pos for pos, label in enumerate(self._frame.index) if label in wanted]
            )
        try:
            position = self._frame.index.index(key)
        except ValueError:
            return DataFrame(columns=self._frame.columns)
        return self._frame._take_positions([position])


class DataFrame:
    def __init__(
        self,
        data: Any = None,
        columns: Sequence[str] | None = None,
        index: Sequence[Any] | None = None,
    ) -> None:
        self._data: OrderedDict[str, list[Any]] = OrderedDict()
        self.index: list[Any] = []
        if isinstance(data, DataFrame):
            self._data = OrderedDict((name, list(values)) for name, values in data._data.items())
            self.index = list(data.index)
        elif data is None:
            self._data = OrderedDict((str(name), []) for name in (columns or []))
        elif isinstance(data, Mapping):
            names = [str(name) for name in (columns or data.keys())]
            raw_values = [data.get(name, []) for name in names]
            lengths = [len(value) for value in raw_values if _is_column_sequence(value)]
            row_count = max(lengths, default=(len(index) if index is not None else 1))
            for name, raw in zip(names, raw_values):
                if isinstance(raw, Series):
                    values = raw.tolist()
                elif isinstance(raw, list):
                    # Rust hands ownership of fresh PyLists to this table. Reuse
                    # them so multi-million-row grenade columns are zero-copy.
                    values = raw
                elif _is_column_sequence(raw):
                    values = list(raw)
                else:
                    values = [raw] * row_count
                if len(values) == 0 and row_count:
                    values = [None] * row_count
                if len(values) != row_count:
                    raise ValueError("All columns must have the same length")
                self._data[name] = values
        elif hasattr(data, "columns") and hasattr(data, "__getitem__"):
            names = [str(name) for name in (columns or data.columns)]
            self._data = OrderedDict(
                (name, data[name].tolist()) for name in names
            )
            try:
                self.index = list(data.index)
            except (AttributeError, TypeError):
                pass
        elif hasattr(data, "to_dict"):
            try:
                records = data.to_dict(orient="records")
            except TypeError:
                records = data.to_dict("records")
            self._from_records(records, columns)
        else:
            self._from_records(list(data), columns)
        row_count = len(next(iter(self._data.values()))) if self._data else 0
        if not self.index:
            self.index = list(index) if index is not None else list(range(row_count))
        elif index is not None:
            self.index = list(index)
        if len(self.index) != row_count:
            raise ValueError("DataFrame data and index must have the same length")

    def _from_records(self, records: list[Any], columns: Sequence[str] | None) -> None:
        if not records:
            self._data = OrderedDict((str(name), []) for name in (columns or []))
            return
        if isinstance(records[0], Mapping):
            names = [str(name) for name in (columns or _record_keys(records))]
            self._data = OrderedDict(
                (name, [record.get(name) for record in records]) for name in names
            )
        else:
            if columns is None:
                raise ValueError("columns are required for sequence rows")
            names = [str(name) for name in columns]
            self._data = OrderedDict(
                (name, [record[pos] if pos < len(record) else None for record in records])
                for pos, name in enumerate(names)
            )

    def __len__(self) -> int:
        return len(self.index)

    def __repr__(self) -> str:
        return f"DataFrame({self.to_dict(orient='records')!r})"

    @property
    def empty(self) -> bool:
        return len(self) == 0

    @property
    def columns(self) -> list[str]:
        return list(self._data.keys())

    @property
    def shape(self) -> tuple[int, int]:
        return len(self), len(self._data)

    @property
    def dtypes(self) -> Series:
        return Series(
            [_infer_dtype(values) for values in self._data.values()],
            index=self.columns,
        )

    @property
    def iloc(self) -> _ILocIndexer:
        return _ILocIndexer(self)

    @property
    def loc(self) -> _LocIndexer:
        return _LocIndexer(self)

    def __getitem__(self, key: Any) -> Any:
        if isinstance(key, str):
            if key not in self._data:
                raise KeyError(key)
            return Series(self._data[key], index=self.index, name=key)
        if isinstance(key, Series):
            return self._take_positions([pos for pos, value in enumerate(key) if bool(value)])
        if isinstance(key, Sequence):
            values = list(key)
            if all(isinstance(value, bool) for value in values):
                return self._take_positions([pos for pos, value in enumerate(values) if value])
            result = DataFrame()
            result._data = OrderedDict((str(name), list(self._data[str(name)])) for name in values)
            result.index = list(self.index)
            return result
        raise KeyError(key)

    def __setitem__(self, name: str, value: Any) -> None:
        if isinstance(value, Series):
            values = value.tolist()
        elif _is_column_sequence(value):
            values = list(value)
        else:
            values = [value] * len(self)
        if not self._data and not self.index:
            self.index = list(range(len(values)))
        if len(values) != len(self):
            raise ValueError("Column length must match DataFrame length")
        self._data[str(name)] = values

    def _row_at(self, position: int) -> Row:
        if position < 0 or position >= len(self):
            raise IndexError(position)
        return Row((name, values[position]) for name, values in self._data.items())

    def _take_positions(self, positions: Sequence[int]) -> "DataFrame":
        result = DataFrame()
        result._data = OrderedDict(
            (name, [values[pos] for pos in positions]) for name, values in self._data.items()
        )
        result.index = [self.index[pos] for pos in positions]
        return result

    def copy(self) -> "DataFrame":
        return DataFrame(self)

    def head(self, count: int = 5) -> "DataFrame":
        return self.iloc[: max(0, int(count))]

    def iterrows(self) -> Iterator[tuple[Any, Row]]:
        for position, label in enumerate(self.index):
            yield label, self._row_at(position)

    def itertuples(self, index: bool = True, name: str | None = "Pandas") -> Iterator[Any]:
        for position, label in enumerate(self.index):
            values = tuple(self._data[column][position] for column in self.columns)
            if index:
                values = (label, *values)
            if name is None:
                yield values
            else:
                from collections import namedtuple

                fields = (["Index"] if index else []) + self.columns
                row_type = namedtuple(str(name), fields, rename=True)
                yield row_type(*values)

    def to_dict(self, orient: str = "dict") -> Any:
        if orient == "records":
            return [dict(self._row_at(position)) for position in range(len(self))]
        if orient in ("list", "series"):
            return {name: list(values) for name, values in self._data.items()}
        if orient == "dict":
            return {
                name: {label: value for label, value in zip(self.index, values)}
                for name, values in self._data.items()
            }
        raise ValueError(f"Unsupported orient: {orient}")

    def sort_values(
        self,
        by: str | Sequence[str],
        ascending: bool | Sequence[bool] = True,
        kind: str | None = None,
    ) -> "DataFrame":
        del kind
        names = [by] if isinstance(by, str) else list(by)
        ascending_values = [ascending] * len(names) if isinstance(ascending, bool) else list(ascending)
        positions = list(range(len(self)))
        for name, asc in reversed(list(zip(names, ascending_values))):
            positions.sort(
                key=lambda pos: _sort_key(self._data[str(name)][pos]),
                reverse=not asc,
            )
        return self._take_positions(positions)

    def reset_index(self, drop: bool = False) -> "DataFrame":
        result = self.copy()
        if not drop:
            result._data = OrderedDict(
                [("index", list(self.index)), *result._data.items()]
            )
        result.index = list(range(len(result)))
        return result

    def drop_duplicates(
        self,
        subset: str | Sequence[str] | None = None,
        keep: str = "first",
    ) -> "DataFrame":
        names = self.columns if subset is None else ([subset] if isinstance(subset, str) else list(subset))
        keys = [tuple(self._data[str(name)][pos] for name in names) for pos in range(len(self))]
        if keep == "last":
            last = {key: pos for pos, key in enumerate(keys)}
            positions = [pos for pos, key in enumerate(keys) if last[key] == pos]
        else:
            seen: set[tuple[Any, ...]] = set()
            positions = []
            for pos, key in enumerate(keys):
                if key not in seen:
                    seen.add(key)
                    positions.append(pos)
        return self._take_positions(positions)

    def drop(self, columns: str | Sequence[str] | None = None, errors: str = "raise") -> "DataFrame":
        names = [] if columns is None else ([columns] if isinstance(columns, str) else list(columns))
        result = self.copy()
        for name in names:
            if name in result._data:
                del result._data[name]
            elif errors != "ignore":
                raise KeyError(name)
        return result

    def dropna(
        self,
        subset: str | Sequence[str] | None = None,
        how: str = "any",
    ) -> "DataFrame":
        names = self.columns if subset is None else ([subset] if isinstance(subset, str) else list(subset))
        positions: list[int] = []
        for pos in range(len(self)):
            missing = [isna(self._data[str(name)][pos]) for name in names]
            reject = all(missing) if how == "all" else any(missing)
            if not reject:
                positions.append(pos)
        return self._take_positions(positions)

    def groupby(self, by: str | Sequence[str], sort: bool = True) -> Iterator[tuple[Any, "DataFrame"]]:
        names = [by] if isinstance(by, str) else list(by)
        groups: OrderedDict[Any, list[int]] = OrderedDict()
        for pos in range(len(self)):
            key_tuple = tuple(self._data[str(name)][pos] for name in names)
            key = key_tuple[0] if len(key_tuple) == 1 else key_tuple
            groups.setdefault(key, []).append(pos)
        items = list(groups.items())
        if sort:
            items.sort(key=lambda item: _sort_key(item[0]))
        return iter((key, self._take_positions(positions)) for key, positions in items)

    def diff(self, periods: int = 1) -> "DataFrame":
        result = DataFrame()
        result._data = OrderedDict(
            (name, Series(values, index=self.index).diff(periods).tolist())
            for name, values in self._data.items()
        )
        result.index = list(self.index)
        return result

    def pow(self, exponent: float) -> "DataFrame":
        result = DataFrame()
        result._data = OrderedDict()
        for name, values in self._data.items():
            powered: list[Any] = []
            for value in values:
                if isna(value):
                    powered.append(value)
                else:
                    powered.append(value ** exponent)
            result._data[name] = powered
        result.index = list(self.index)
        return result

    def sum(self, axis: int = 0) -> Any:
        if axis == 1:
            return Series(
                [
                    sum(
                        value
                        for value in (self._data[name][pos] for name in self.columns)
                        if not isna(value)
                    )
                    for pos in range(len(self))
                ],
                index=self.index,
            )
        return Series(
            [sum(value for value in self._data[name] if not isna(value)) for name in self.columns],
            index=self.columns,
        )


def _is_column_sequence(value: Any) -> bool:
    return isinstance(value, (Series, list, tuple, range, deque))


def _record_keys(records: Sequence[Mapping[Any, Any]]) -> list[str]:
    keys: list[str] = []
    for record in records:
        for key in record:
            text = str(key)
            if text not in keys:
                keys.append(text)
    return keys


def _sort_key(value: Any) -> tuple[bool, str, Any]:
    if isna(value):
        return True, "", 0
    if isinstance(value, (int, float, str)):
        return False, type(value).__name__, value
    return False, type(value).__name__, repr(value)


def _infer_dtype(values: Sequence[Any]) -> str:
    concrete = [value for value in values if not isna(value)]
    if not concrete:
        return "object"
    types = {type(value) for value in concrete}
    if types <= {bool}:
        return "bool"
    if types <= {bool, int}:
        return "int64"
    if types <= {bool, int, float}:
        return "float64"
    if types <= {str}:
        return "string"
    return "object"


def to_numeric(value: Any, errors: str = "raise") -> Any:
    if isinstance(value, Series):
        return Series([to_numeric(item, errors=errors) for item in value], index=value.index, name=value.name)
    if isna(value):
        return float("nan")
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return value
    try:
        text = str(value).strip()
        if not text:
            raise ValueError("empty numeric value")
        number = float(text)
        return int(number) if number.is_integer() else number
    except (TypeError, ValueError, OverflowError):
        if errors == "coerce":
            return float("nan")
        if errors == "ignore":
            return value
        raise


def concat(frames: Iterable[Any], ignore_index: bool = False) -> DataFrame:
    tables = [DataFrame(frame) for frame in frames]
    columns: list[str] = []
    for frame in tables:
        for name in frame.columns:
            if name not in columns:
                columns.append(name)
    records: list[dict[str, Any]] = []
    indices: list[Any] = []
    for frame in tables:
        records.extend(frame.to_dict(orient="records"))
        indices.extend(frame.index)
    result = DataFrame(records, columns=columns)
    result.index = list(range(len(result))) if ignore_index else indices
    return result
