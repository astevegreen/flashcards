import Capacitor
import UIKit

/// Capacitor bridge controller (set as the root view controller in `Main.storyboard`).
/// Registers the app's own plugins, which are not npm packages and so are not picked up by
/// `cap sync`.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ICloudDocumentsPlugin())
    }
}
