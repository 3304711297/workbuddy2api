/**
 * 顶层错误边界：渲染期异常兜底为可恢复的错误页（与自建 toast/confirm/update UI 对齐，
 * 不依赖第三方）。提供「重试」与「重新加载」两个出口。
 */
import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[AppErrorBoundary] 渲染异常:', error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <div className="error-boundary-card">
            <h2>界面渲染出错</h2>
            <p className="muted">某个页面组件抛出了异常，应用已阻止崩溃扩散。</p>
            <pre className="error-detail mono">{String(this.state.error.message || this.state.error)}</pre>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={this.handleRetry}>
                重试渲染
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={this.handleReload}>
                重新加载
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
