/**
 * Loads a PDF document. Passes it to all children.
 */
import React, { Component } from 'react';
import PropTypes from 'prop-types';
import mergeClassNames from 'merge-class-names';
import pdfjs, { PDFDataRangeTransport } from 'pdfjs-dist';

import LinkService from './LinkService';

import {
  callIfDefined,
  cancelRunningTask,
  dataURItoUint8Array,
  displayCORSWarning,
  errorOnDev,
  isArrayBuffer,
  isBlob,
  isBrowser,
  isDataURI,
  isFile,
  isParamObject,
  makeCancellable,
  warnOnDev,
} from './shared/utils';

import { makeEventProps } from './shared/events';

import { eventsProps, isClassName, isLinkService, isPdf } from './shared/propTypes';

export default class Document extends Component {
  state = {
    pdf: null,
  }

  viewer = {
    scrollPageIntoView: ({ pageNumber }) => {
      // Handling jumping to internal links target

      // First, check if custom handling of onItemClick was provided
      if (this.props.onItemClick) {
        this.props.onItemClick({ pageNumber });
        return;
      }

      // If not, try to look for target page within the <Document>.
      const page = this.pages[pageNumber - 1];

      if (page) {
        // Scroll to the page automatically
        page.scrollIntoView();
        return;
      }

      warnOnDev(`Warning: An internal link leading to page ${pageNumber} was clicked, but neither <Document> was provided with onItemClick nor it was able to find the page within itself. Either provide onItemClick to <Document> and handle navigating by yourself or ensure that all pages are rendered within <Document>.`);
    },
  };

  linkService = new LinkService();

  componentDidMount() {
    this.loadDocument();

    this.linkService.setViewer(this.viewer);
  }

  componentWillReceiveProps(nextProps) {
    if (this.shouldLoadDocument(nextProps)) {
      if (this.state.pdf !== null) {
        this.setState({ pdf: null });
      }

      this.loadDocument(nextProps);
    }
  }

  componentWillUnmount() {
    cancelRunningTask(this.runningTask);
  }

  getChildContext() {
    const { linkService, registerPage, unregisterPage } = this;
    const { rotate } = this.props;
    const { pdf } = this.state;

    return {
      linkService,
      pdf,
      registerPage,
      rotate,
      unregisterPage,
    };
  }

  get eventProps() {
    return makeEventProps(this.props, () => this.state.pdf);
  }

  /**
   * Called when a document source is resolved correctly
   */
  onSourceSuccess = (source) => {
    callIfDefined(this.props.onSourceSuccess);

    if (!source) {
      return null;
    }

    const { options } = this.props;

    this.runningTask = makeCancellable(pdfjs.getDocument({ ...source, ...options }));

    return this.runningTask.promise
      .then(this.onLoadSuccess)
      .catch(this.onLoadError);
  }

  /**
   * Called when a document source failed to be resolved correctly
   */
  onSourceError = (error) => {
    if (
      error.name === 'RenderingCancelledException' ||
      error.name === 'PromiseCancelledException'
    ) {
      return;
    }

    errorOnDev(error.message, error);

    callIfDefined(
      this.props.onSourceError,
      error,
    );

    this.setState({ pdf: false });
  }

  /**
   * Called when a document is read successfully
   */
  onLoadSuccess = (pdf) => {
    this.setState({ pdf }, () => {
      callIfDefined(
        this.props.onLoadSuccess,
        pdf,
      );

      this.pages = new Array(pdf.numPages);
      this.linkService.setDocument(pdf);
    });
  }

  /**
   * Called when a document failed to read successfully
   */
  onLoadError = (error) => {
    if (
      error.name === 'RenderingCancelledException' ||
      error.name === 'PromiseCancelledException'
    ) {
      return;
    }

    errorOnDev(error.message, error);

    callIfDefined(
      this.props.onLoadError,
      error,
    );

    this.setState({ pdf: false });
  }

  shouldLoadDocument(nextProps) {
    const { src: nextSrc } = nextProps;
    const { src } = this.props;

    // We got src of different type - clearly there was a change
    if (typeof nextSrc !== typeof src) {
      return true;
    }

    // We got an object and previously it was an object too - we need to compare deeply
    if (isParamObject(nextSrc) && isParamObject(src)) {
      return (
        nextSrc.data !== src.data ||
        nextSrc.range !== src.range ||
        nextSrc.url !== src.url
      );
    // We either have or had an object - most likely there was a change
    } else if (isParamObject(nextSrc) || isParamObject(src)) {
      return true;
    }

    /**
     * The cases below are browser-only.
     * If you're running on a non-browser environment, these cases will be of no use.
     */
    if (
      isBrowser &&
      // Src is a Blob or a Src
      (isBlob(nextSrc) || isFile(nextSrc)) &&
      (isBlob(src) || isFile(src))
    ) {
      /**
       * Theoretically, we could compare srcs here by reading them, but that would severely affect
       * performance. Therefore, we're making a compromise here, agreeing on not loading the next
       * src if its size is identical as the previous one's.
       */
      return nextSrc.size !== src.size;
    }

    return nextSrc !== src;
  }

  loadDocument(props = this.props) {
    cancelRunningTask(this.runningTask);

    this.runningTask = makeCancellable(this.findDocumentSource(props));

    return this.runningTask.promise
      .then(this.onSourceSuccess)
      .catch(this.onSourceError);
  }

  /**
   * Attempts to find a document source based on props.
   */
  findDocumentSource = (props = this.props) => new Promise((resolve, reject) => {
    const { src } = props;

    if (!src) {
      return resolve(null);
    }

    // src is a string
    if (typeof src === 'string') {
      if (isDataURI(src)) {
        const fileUint8Array = dataURItoUint8Array(src);
        return resolve({ data: fileUint8Array });
      }

      displayCORSWarning();
      return resolve({ url: src });
    }

    // src is PDFDataRangeTransport
    if (src instanceof PDFDataRangeTransport) {
      return resolve({ range: src });
    }

    // src is an array buffer
    if (isArrayBuffer(src)) {
      return resolve({ data: src });
    }

    /**
     * The cases below are browser-only.
     * If you're running on a non-browser environment, these cases will be of no use.
     */
    if (isBrowser) {
      // File is a Blob
      if (isBlob(src) || isFile(src)) {
        const reader = new FileReader();

        reader.onload = () => resolve({ data: new Uint8Array(reader.result) });
        reader.onerror = (event) => {
          switch (event.target.error.code) {
            case event.target.error.NOT_FOUND_ERR:
              return reject(new Error('Error while reading a file: File not found.'));
            case event.target.error.NOT_READABLE_ERR:
              return reject(new Error('Error while reading a file: File not readable.'));
            case event.target.error.SECURITY_ERR:
              return reject(new Error('Error while reading a file: Security error.'));
            case event.target.error.ABORT_ERR:
              return reject(new Error('Error while reading a file: Aborted.'));
            default:
              return reject(new Error('Error while reading a file.'));
          }
        };
        reader.readAsArrayBuffer(src);

        return null;
      }
    }

    // At this point, src must be an object
    if (typeof src !== 'object') {
      reject(new Error('Invalid parameter in src, need either Uint8Array, string or a parameter object'));
    }

    if (!src.url && !src.data && !src.range) {
      reject(new Error('Invalid parameter object: need either .data, .range or .url'));
    }

    return resolve(src);
  })

  registerPage = (pageIndex, ref) => {
    this.pages[pageIndex] = ref;
  }

  unregisterPage = (pageIndex) => {
    delete this.pages[pageIndex];
  }

  renderNoData() {
    return (
      <div className="react-pdf__message react-pdf__message--no-data">{this.props.noData}</div>
    );
  }

  renderError() {
    return (
      <div className="react-pdf__message react-pdf__message--error">{this.props.error}</div>
    );
  }

  renderLoader() {
    return (
      <div className="react-pdf__message react-pdf__message--loading">{this.props.loading}</div>
    );
  }

  render() {
    const { className, src, inputRef } = this.props;
    const { pdf } = this.state;

    let content;
    if (!src) {
      content = this.renderNoData();
    } else if (pdf === null) {
      content = this.renderLoader();
    } else if (pdf === false) {
      content = this.renderError();
    } else {
      content = this.props.children;
    }

    return (
      <div
        className={mergeClassNames('react-pdf__Document', className)}
        ref={inputRef}
        {...this.eventProps}
      >
        {content}
      </div>
    );
  }
}

Document.childContextTypes = {
  linkService: isLinkService,
  pdf: isPdf,
  registerPage: PropTypes.func,
  rotate: PropTypes.number,
  unregisterPage: PropTypes.func,
};

Document.defaultProps = {
  error: 'Failed to load PDF file.',
  loading: 'Loading PDF…',
  noData: 'No PDF file specified.',
};

Document.propTypes = {
  children: PropTypes.node,
  className: isClassName,
  error: PropTypes.node,
  src: isFile,
  inputRef: PropTypes.func,
  loading: PropTypes.node,
  noData: PropTypes.node,
  onItemClick: PropTypes.func,
  onLoadError: PropTypes.func,
  onLoadSuccess: PropTypes.func,
  onSourceError: PropTypes.func,
  onSourceSuccess: PropTypes.func,
  options: PropTypes.shape({
    cMapPacked: PropTypes.bool,
    cMapUrl: PropTypes.string,
  }),
  rotate: PropTypes.number,
  ...eventsProps(),
};
