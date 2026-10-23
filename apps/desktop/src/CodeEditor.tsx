import {
  Component,
  Suspense,
  lazy,
  type ComponentProps,
  type ReactNode,
} from "react";
import { errorMessage } from "./comparison";

const Surface = lazy(() =>
  import("./EditorSurface").then((module) => ({
    default: module.EditorSurface,
  })),
);

class EditorFailure extends Component<
  { children: ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(error: unknown) {
    return { error: errorMessage(error) };
  }
  render() {
    return this.state.error ? (
      <p role="alert">
        Editor failed to load: {this.state.error}. Your text is retained;
        restart the app to retry.
      </p>
    ) : (
      this.props.children
    );
  }
}

export function CodeEditor(props: ComponentProps<typeof Surface>) {
  return (
    <EditorFailure>
      <Suspense fallback={<p role="status">Loading editor...</p>}>
        <Surface {...props} />
      </Suspense>
    </EditorFailure>
  );
}
