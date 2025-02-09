/**
 * @module @cubejs-client/core
 */

import {
  groupBy, pipe, toPairs, uniq, filter, map, unnest, dropLast, equals, reduce, minBy, maxBy
} from 'ramda';
import Moment from 'moment';
import momentRange from 'moment-range';

const moment = momentRange.extendMoment(Moment);

const TIME_SERIES = {
  day: (range) => Array.from(range.by('day'))
    .map(d => d.format('YYYY-MM-DDT00:00:00.000')),
  month: (range) => Array.from(range.snapTo('month').by('month'))
    .map(d => d.format('YYYY-MM-01T00:00:00.000')),
  year: (range) => Array.from(range.snapTo('year').by('year'))
    .map(d => d.format('YYYY-01-01T00:00:00.000')),
  hour: (range) => Array.from(range.by('hour'))
    .map(d => d.format('YYYY-MM-DDTHH:00:00.000')),
  week: (range) => Array.from(range.snapTo('isoweek').by('week'))
    .map(d => d.startOf('isoweek').format('YYYY-MM-DDT00:00:00.000'))
};

/**
 * Provides a convenient interface for data manipulation.
 */
class ResultSet {
  constructor(loadResponse) {
    this.loadResponse = loadResponse;
  }

  series(pivotConfig) {
    return this.seriesNames(pivotConfig).map(({ title, key }) => ({
      title,
      series: this.chartPivot(pivotConfig).map(({ category, x, ...obj }) => ({ value: obj[key], category, x }))
    }));
  }

  axisValues(axis) {
    const { query } = this.loadResponse;
    return row => {
      const value = (measure) => axis.filter(d => d !== 'measures')
        .map(d => (row[d] != null ? row[d] : null)).concat(measure ? [measure] : []);
      if (axis.find(d => d === 'measures') && (query.measures || []).length) {
        return query.measures.map(value);
      }
      return [value()];
    };
  }

  axisValuesString(axisValues, delimiter) {
    const formatValue = (v) => {
      if (v == null) {
        return '∅';
      } else if (v === '') {
        return '[Empty string]';
      } else {
        return v;
      }
    };
    return axisValues.map(formatValue).join(delimiter || ', ');
  }

  normalizePivotConfig(pivotConfig) {
    const { query } = this.loadResponse;
    const timeDimensions = (query.timeDimensions || []).filter(td => !!td.granularity);
    pivotConfig = pivotConfig || (timeDimensions.length ? {
      x: timeDimensions.map(td => td.dimension),
      y: query.dimensions || []
    } : {
      x: query.dimensions || [],
      y: []
    });
    pivotConfig.x = pivotConfig.x || [];
    pivotConfig.y = pivotConfig.y || [];
    const allIncludedDimensions = pivotConfig.x.concat(pivotConfig.y);
    const allDimensions = timeDimensions.map(td => td.dimension).concat(query.dimensions);
    pivotConfig.x = pivotConfig.x.concat(allDimensions.filter(d => allIncludedDimensions.indexOf(d) === -1));
    if (!pivotConfig.x.concat(pivotConfig.y).find(d => d === 'measures')) {
      pivotConfig.y = pivotConfig.y.concat(['measures']);
    }
    if (!(query.measures || []).length) {
      pivotConfig.x = pivotConfig.x.filter(d => d !== 'measures');
      pivotConfig.y = pivotConfig.y.filter(d => d !== 'measures');
    }
    if (pivotConfig.fillMissingDates == null) {
      pivotConfig.fillMissingDates = true;
    }
    return pivotConfig;
  }

  static measureFromAxis(axisValues) {
    return axisValues[axisValues.length - 1];
  }

  timeSeries(timeDimension) {
    if (!timeDimension.granularity) {
      return null;
    }
    let { dateRange } = timeDimension;
    if (!dateRange) {
      const dates = pipe(
        map(row => row[timeDimension.dimension] && moment(row[timeDimension.dimension])),
        filter(r => !!r)
      )(this.loadResponse.data);

      dateRange = dates.length && [
        reduce(minBy(d => d.toDate()), dates[0], dates),
        reduce(maxBy(d => d.toDate()), dates[0], dates)
      ] || null;
    }
    if (!dateRange) {
      return null;
    }
    const start = moment(dateRange[0]).format('YYYY-MM-DD 00:00:00');
    const end = moment(dateRange[1]).format('YYYY-MM-DD 23:59:59');
    const range = moment.range(start, end);
    if (!TIME_SERIES[timeDimension.granularity]) {
      throw new Error(`Unsupported time granularity: ${timeDimension.granularity}`);
    }
    return TIME_SERIES[timeDimension.granularity](range);
  }

  pivot(pivotConfig) {
    pivotConfig = this.normalizePivotConfig(pivotConfig);
    let groupByXAxis = groupBy(({ xValues }) => this.axisValuesString(xValues));

    // eslint-disable-next-line no-unused-vars
    let measureValue = (row, measure, xValues) => row[measure];

    if (
      pivotConfig.fillMissingDates &&
      pivotConfig.x.length === 1 &&
      equals(
        pivotConfig.x,
        (this.loadResponse.query.timeDimensions || []).filter(td => !!td.granularity).map(td => td.dimension)
      )
    ) {
      const series = this.timeSeries(this.loadResponse.query.timeDimensions[0]);
      if (series) {
        groupByXAxis = (rows) => {
          const byXValues = groupBy(
            ({ xValues }) => moment(xValues[0]).format(moment.HTML5_FMT.DATETIME_LOCAL_MS),
            rows
          );
          return series.map(d => ({ [d]: byXValues[d] || [{ xValues: [d], row: {} }] }))
            .reduce((a, b) => Object.assign(a, b), {});
        };

        // eslint-disable-next-line no-unused-vars
        measureValue = (row, measure, xValues) => row[measure] || 0;
      }
    }

    const xGrouped = pipe(
      map(row => this.axisValues(pivotConfig.x)(row).map(xValues => ({ xValues, row }))),
      unnest,
      groupByXAxis,
      toPairs
    )(this.loadResponse.data);

    const allYValues = pipe(
      map(
        // eslint-disable-next-line no-unused-vars
        ([xValuesString, rows]) => unnest(
          // collect Y values only from filled rows
          rows.filter(({ row }) => Object.keys(row).length > 0).map(({ row }) => this.axisValues(pivotConfig.y)(row))
        )
      ),
      unnest,
      uniq
    )(xGrouped);

    // eslint-disable-next-line no-unused-vars
    return xGrouped.map(([xValuesString, rows]) => {
      const { xValues } = rows[0];
      const yGrouped = pipe(
        map(({ row }) => this.axisValues(pivotConfig.y)(row).map(yValues => ({ yValues, row }))),
        unnest,
        groupBy(({ yValues }) => this.axisValuesString(yValues))
      )(rows);
      return {
        xValues,
        yValuesArray: unnest(allYValues.map(yValues => {
          const measure = pivotConfig.x.find(d => d === 'measures') ?
            ResultSet.measureFromAxis(xValues) :
            ResultSet.measureFromAxis(yValues);
          return (yGrouped[this.axisValuesString(yValues)] ||
            [{ row: {} }]).map(({ row }) => [yValues, measureValue(row, measure, xValues)]);
        }))
      };
    });
  }

  pivotedRows(pivotConfig) { // TODO
    return this.chartPivot(pivotConfig);
  }

  /**
   * Returns normalized query result data in the following format.
   *
   * ```js
   * // For query
   * {
   *   measures: ['Stories.count'],
   *   timeDimensions: [{
   *     dimension: 'Stories.time',
   *     dateRange: ['2015-01-01', '2015-12-31'],
   *     granularity: 'month'
   *   }]
   * }
   *
   * // ResultSet.chartPivot() will return
   * [
   *   { "x":"2015-01-01T00:00:00", "Stories.count": 27120 },
   *   { "x":"2015-02-01T00:00:00", "Stories.count": 25861 },
   *   { "x": "2015-03-01T00:00:00", "Stories.count": 29661 },
   *   //...
   * ]
   * ```
   * @param pivotConfig
   */
  chartPivot(pivotConfig) {
    return this.pivot(pivotConfig).map(({ xValues, yValuesArray }) => ({
      category: this.axisValuesString(xValues, ', '), // TODO deprecated
      x: this.axisValuesString(xValues, ', '),
      ...(
        yValuesArray
          .map(([yValues, m]) => ({ [this.axisValuesString(yValues, ', ')]: m && Number.parseFloat(m) }))
          .reduce((a, b) => Object.assign(a, b), {})
      )
    }));
  }

  /**
   * Returns normalized query result data prepared for visualization in the table format.
   *
   * For example
   *
   * ```js
   * // For query
   * {
   *   measures: ['Stories.count'],
   *   timeDimensions: [{
   *     dimension: 'Stories.time',
   *     dateRange: ['2015-01-01', '2015-12-31'],
   *     granularity: 'month'
   *   }]
   * }
   *
   * // ResultSet.tablePivot() will return
   * [
   *   { "Stories.time": "2015-01-01T00:00:00", "Stories.count": 27120 },
   *   { "Stories.time": "2015-02-01T00:00:00", "Stories.count": 25861 },
   *   { "Stories.time": "2015-03-01T00:00:00", "Stories.count": 29661 },
   *   //...
   * ]
   * ```
   * @param pivotConfig
   * @returns {Array} of pivoted rows
   */
  tablePivot(pivotConfig) {
    const normalizedPivotConfig = this.normalizePivotConfig(pivotConfig);
    const valueToObject =
      (valuesArray, measureValue) => (
        (field, index) => ({
          [field === 'measures' ? valuesArray[index] : field]: field === 'measures' ? measureValue : valuesArray[index]
        })
      );

    return this.pivot(normalizedPivotConfig).map(({ xValues, yValuesArray }) => (
      yValuesArray.map(([yValues, m]) => (
        normalizedPivotConfig.x.map(valueToObject(xValues, m))
          .concat(normalizedPivotConfig.y.map(valueToObject(yValues, m)))
          .reduce((a, b) => Object.assign(a, b), {})
      )).reduce((a, b) => Object.assign(a, b), {})
    ));
  }

  /**
   * Returns array of column definitions for `tablePivot`.
   *
   * For example
   *
   * ```js
   * // For query
   * {
   *   measures: ['Stories.count'],
   *   timeDimensions: [{
   *     dimension: 'Stories.time',
   *     dateRange: ['2015-01-01', '2015-12-31'],
   *     granularity: 'month'
   *   }]
   * }
   *
   * // ResultSet.tableColumns() will return
   * [
   *   { key: "Stories.time", title: "Stories Time" },
   *   { key: "Stories.count", title: "Stories Count" },
   *   //...
   * ]
   * ```
   * @param pivotConfig
   * @returns {Array} of columns
   */
  tableColumns(pivotConfig) {
    const normalizedPivotConfig = this.normalizePivotConfig(pivotConfig);
    const column = field => (
      field === 'measures' ?
        (this.query().measures || []).map(m => ({ key: m, title: this.loadResponse.annotation.measures[m].title })) :
        [{
          key: field,
          title: (
            this.loadResponse.annotation.dimensions[field] ||
            this.loadResponse.annotation.timeDimensions[field]
          ).title
        }]
    );
    return normalizedPivotConfig.x.map(column)
      .concat(normalizedPivotConfig.y.map(column))
      .reduce((a, b) => a.concat(b));
  }

  totalRow() {
    return this.chartPivot()[0];
  }

  categories(pivotConfig) { // TODO
    return this.chartPivot(pivotConfig);
  }

  /**
   * Returns the array of series objects, containing `key` and `title` parameters.
   *
   * ```js
   * // For query
   * {
   *   measures: ['Stories.count'],
   *   timeDimensions: [{
   *     dimension: 'Stories.time',
   *     dateRange: ['2015-01-01', '2015-12-31'],
   *     granularity: 'month'
   *   }]
   * }
   *
   * // ResultSet.seriesNames() will return
   * [
   * { "key":"Stories.count", "title": "Stories Count" }
   * ]
   * ```
   * @param pivotConfig
   * @returns {Array} of series names
   */
  seriesNames(pivotConfig) {
    pivotConfig = this.normalizePivotConfig(pivotConfig);
    return pipe(map(this.axisValues(pivotConfig.y)), unnest, uniq)(this.loadResponse.data).map(axisValues => ({
      title: this.axisValuesString(pivotConfig.y.find(d => d === 'measures') ?
        dropLast(1, axisValues)
          .concat(this.loadResponse.annotation.measures[ResultSet.measureFromAxis(axisValues)].title) :
        axisValues, ', '),
      key: this.axisValuesString(axisValues)
    }));
  }

  query() {
    return this.loadResponse.query;
  }

  rawData() {
    return this.loadResponse.data;
  }
}

export default ResultSet;
