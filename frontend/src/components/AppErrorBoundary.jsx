import { Component } from 'react';

export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(err) {
    return { hasError: true, message: err?.message || 'Something went wrong' };
  }

  componentDidCatch(err, info) {
    console.error('[AppErrorBoundary]', err, info?.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[40vh] flex flex-col items-center justify-center gap-3 p-6 text-center">
          <h1 className="text-lg font-bold text-gray-900">Something went wrong</h1>
          <p className="text-sm text-gray-600 max-w-md">{this.state.message}</p>
          <button
            type="button"
            className="px-4 py-2 rounded-md bg-primary-600 text-white text-sm font-semibold"
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
