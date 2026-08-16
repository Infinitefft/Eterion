import {
  useState,
  useEffect,
} from 'react';

import { getModelList } from '@/api';

import { useModelList } from '@/store';

export default function ModelList() {
  const [open, setOpen] = useState<boolean>(false);
  const { modelList, defaultModel } = useModelList;
  const [showModel, setShowModel] = useState<model>(defaultModel);
  useEffect(() => {
    
  }, [modelList])

  const handleChangeModel = (modelId) => {
    setShowModel(modelList[modelId]);
  }
  return (
    <>
      <div>
        {open ? modelList.map((model) => (
          <ul>
            <li>
              <button onClick={handleChangeModel(model.Id: string)}>
                <span>
                  {model.icon}
                </span>
                <p>
                  {model.name}
                </p>
              </button>
            </li>
          </ul>
        )) : (<div>
          <span>{showModel.icon}</span>
          <p>{showModel.name}</p>
        </div>)
        }
      </div>
    </>
  )
}