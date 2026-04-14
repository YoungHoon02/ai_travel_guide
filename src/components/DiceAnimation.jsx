import Lottie from "lottie-react";
import { useEffect, useState } from "react";

// Lottie dice animation from LottieFiles CDN
const DICE_LOTTIE_URL = "https://lottie.host/0a7c5a1e-5a14-4a45-b13b-2db0c1a5d8f7/yQbRnRdVdX.json";

export default function DiceAnimation({ playing }) {
  const [animData, setAnimData] = useState(null);

  useEffect(() => {
    fetch(DICE_LOTTIE_URL)
      .then((r) => r.json())
      .then(setAnimData)
      .catch(() => setAnimData(null));
  }, []);

  if (!animData || !playing) return null;

  return (
    <div className="dice-lottie">
      <Lottie
        animationData={animData}
        loop={true}
        autoplay={true}
        style={{ width: 32, height: 32 }}
      />
    </div>
  );
}
